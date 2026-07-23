import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const serverModule = require("../server.js");
const MAX_REQUEST_BODY_BYTES = 31 * 1024 * 1024;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function withAppServer(run) {
  const server = serverModule.createAppServer();
  const origin = await listen(server);
  try {
    await run(origin);
  } finally {
    await close(server);
  }
}

function request(origin, pathname, { body, chunks, headers = {}, method = "GET", timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { headers, method }, (res) => {
      const responseChunks = [];
      res.on("data", (chunk) => responseChunks.push(chunk));
      res.on("end", () => resolve({
        body: Buffer.concat(responseChunks),
        headers: res.headers,
        status: res.statusCode
      }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);

    if (chunks) {
      (async () => {
        try {
          for (const chunk of chunks) {
            if (!req.write(chunk)) {
              await once(req, "drain");
            }
          }
          req.end();
        } catch (error) {
          if (!req.destroyed) {
            req.destroy(error);
          }
        }
      })();
      return;
    }

    req.end(body);
  });
}

function oversizedHeaderRequest(origin) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("server did not reject oversized Content-Length immediately"));
    }, 750);

    socket.setEncoding("latin1");
    socket.on("connect", () => {
      socket.write([
        "POST /api/auth HTTP/1.1",
        `Host: ${hostname}:${port}`,
        `Content-Length: ${MAX_REQUEST_BODY_BYTES + 1}`,
        "Content-Type: application/json",
        "Connection: close",
        "",
        ""
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      response += chunk;
      const match = response.match(/^HTTP\/1\.1 (\d{3})/);
      if (match) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await close(probe);
  return port;
}

async function withChildServer(run, env) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const origin = `http://127.0.0.1:${port}`;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server exited with code ${child.exitCode}: ${stderr}`);
      }
      try {
        await request(origin, "/healthz", { timeoutMs: 250 });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await run(origin);
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }
  }
}

test("oversized Content-Length is rejected before the API waits for the body", async () => {
  await withAppServer(async (origin) => {
    assert.equal(await oversizedHeaderRequest(origin), 413);
  });
});

test("chunked request bodies are rejected when their total exceeds 31 MiB", async () => {
  await withAppServer(async (origin) => {
    const chunks = Array.from({ length: 31 }, () => Buffer.alloc(1024 * 1024));
    chunks.push(Buffer.from([0]));
    const response = await request(origin, "/api/uploads", {
      chunks,
      headers: { "Content-Type": "application/octet-stream" },
      method: "POST",
      timeoutMs: 10000
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, "close");
  });
});

test("a request body at the 31 MiB boundary reaches API authorization", async () => {
  await withAppServer(async (origin) => {
    const body = Buffer.alloc(MAX_REQUEST_BODY_BYTES);
    const response = await request(origin, "/api/uploads", {
      body,
      headers: {
        "Content-Length": String(body.length),
        "Content-Type": "application/octet-stream"
      },
      method: "POST",
      timeoutMs: 10000
    });
    assert.equal(response.status, 401);
  });
});

test("Web responses stream the first chunk before the source completes", async () => {
  assert.equal(typeof serverModule.sendWebResponse, "function");

  let releaseSecondChunk;
  let secondChunkReleased = false;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first-"));
      releaseSecondChunk = () => {
        if (secondChunkReleased) {
          return;
        }
        secondChunkReleased = true;
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      };
    }
  });
  const server = http.createServer((req, res) => serverModule.sendWebResponse(
    res,
    new Response(source, {
      headers: { "Content-Type": "application/octet-stream", "X-Stream-Test": "yes" },
      status: 206
    })
  ));
  const origin = await listen(server);
  let firstChunk;
  let resolveFirstChunk;
  let complete = false;
  const firstChunkReceived = new Promise((resolve) => {
    resolveFirstChunk = resolve;
  });

  try {
    const completed = new Promise((resolve, reject) => {
      http.get(origin, (res) => {
        assert.equal(res.statusCode, 206);
        assert.equal(res.headers["x-stream-test"], "yes");
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
          firstChunk ||= chunk;
          resolveFirstChunk();
        });
        res.on("end", () => {
          complete = true;
          resolve(Buffer.concat(chunks));
        });
      }).on("error", reject);
    });

    await Promise.race([
      firstChunkReceived,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error("first response chunk was buffered")), 500).unref();
      })
    ]);
    assert.equal(firstChunk.toString(), "first-");
    assert.equal(complete, false);
    releaseSecondChunk();
    assert.equal((await completed).toString(), "first-second");
  } finally {
    releaseSecondChunk?.();
    await close(server);
  }
});

test("healthz reports ready local storage without caching", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-health-"));
  try {
    await withChildServer(async (origin) => {
      const response = await request(origin, "/healthz");
      assert.equal(response.status, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(response.body.toString()), { status: "ok" });
      await fs.access(path.join(dataDir, "records"));
    }, { HTML_WORKBENCH_DATA_DIR: dataDir });
  } finally {
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});

test("healthz returns 503 when local storage cannot be prepared", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-health-fail-"));
  const dataFile = path.join(tempDir, "not-a-directory");
  await fs.writeFile(dataFile, "occupied", "utf8");
  try {
    await withChildServer(async (origin) => {
      const response = await request(origin, "/healthz");
      assert.equal(response.status, 503);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(JSON.parse(response.body.toString()), { status: "unavailable" });
    }, { HTML_WORKBENCH_DATA_DIR: dataFile });
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});
