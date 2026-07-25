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
  const previousAdminOrigin = process.env.HTML_WORKBENCH_ADMIN_ORIGIN;
  const previousPublicOrigin = process.env.HTML_WORKBENCH_PUBLIC_ORIGIN;
  process.env.HTML_WORKBENCH_ADMIN_ORIGIN = origin;
  process.env.HTML_WORKBENCH_PUBLIC_ORIGIN = origin;
  try {
    await run(origin);
  } finally {
    if (previousAdminOrigin === undefined) delete process.env.HTML_WORKBENCH_ADMIN_ORIGIN;
    else process.env.HTML_WORKBENCH_ADMIN_ORIGIN = previousAdminOrigin;
    if (previousPublicOrigin === undefined) delete process.env.HTML_WORKBENCH_PUBLIC_ORIGIN;
    else process.env.HTML_WORKBENCH_PUBLIC_ORIGIN = previousPublicOrigin;
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

async function authenticate(origin) {
  const body = JSON.stringify({ password: "885688" });
  const response = await request(origin, "/api/auth", {
    body,
    headers: {
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/json",
      Origin: origin
    },
    method: "POST"
  });
  assert.equal(response.status, 200);
  const setCookie = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"][0]
    : response.headers["set-cookie"];
  return setCookie.split(";", 1)[0];
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

function unfinishedUnauthorizedUpload(origin) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostname, port: Number(port) });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("server waited for an unauthorized request body"));
    }, 750);

    socket.setEncoding("latin1");
    socket.on("connect", () => {
      socket.write([
        "POST /api/uploads HTTP/1.1",
        `Host: ${hostname}:${port}`,
        "Transfer-Encoding: chunked",
        "Content-Type: application/octet-stream",
        "Connection: close",
        "",
        ""
      ].join("\r\n"));
      socket.write(`400\r\n${"x".repeat(1024)}\r\n`);
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
    env: { ...process.env, ...env,
      HTML_WORKBENCH_ADMIN_ORIGIN: `http://127.0.0.1:${port}`,
      HTML_WORKBENCH_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      HOST: "127.0.0.1",
      PORT: String(port)
    },
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

test("unauthorized uploads are rejected before the request body ends", async () => {
  await withAppServer(async (origin) => {
    assert.equal(await unfinishedUnauthorizedUpload(origin), 401);
  });
});

test("malformed auth cookies are treated as unauthorized", async () => {
  await withAppServer(async (origin) => {
    const response = await request(origin, "/api/uploads", {
      headers: { Cookie: "html_workbench_auth=%" }
    });
    assert.equal(response.status, 401);
  });
});
test("chunked request bodies are rejected when their total exceeds 31 MiB", async () => {
  await withAppServer(async (origin) => {
    const cookie = await authenticate(origin);
    const chunks = Array.from({ length: 31 }, () => Buffer.alloc(1024 * 1024));
    chunks.push(Buffer.from([0]));
    const response = await request(origin, "/api/uploads", {
      chunks,
      headers: {
        Cookie: cookie,
        "Content-Type": "application/octet-stream"
      },
      method: "POST",
      timeoutMs: 10000
    });
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, "close");
  });
});

test("a request body at the 31 MiB boundary is accepted by the body collector", async () => {
  await withAppServer(async (origin) => {
    const body = Buffer.alloc(MAX_REQUEST_BODY_BYTES);
    const response = await request(origin, "/api/auth", {
      body,
      headers: {
        "Content-Length": String(body.length),
        "Content-Type": "application/octet-stream",
        Origin: origin
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

test("an explicitly configured busy port exits instead of falling back", async () => {
  const occupied = http.createServer();
  const origin = await listen(occupied);
  const port = new URL(origin).port;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      HTML_WORKBENCH_ADMIN_ORIGIN: origin,
      HTML_WORKBENCH_PUBLIC_ORIGIN: origin,
      PORT: port
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("explicit busy port did not exit")), 1000))
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /EADDRINUSE/);
  } finally {
    if (child.exitCode === null) child.kill();
    await close(occupied);
  }
});

test("developer fallback updates the default origin after the default port is busy", async (t) => {
  const occupied = http.createServer();
  try {
    await new Promise((resolve, reject) => occupied.listen(3000, "127.0.0.1", resolve).once("error", reject));
  } catch (error) {
    t.skip(`port 3000 is unavailable: ${error.code || error.message}`);
    return;
  }

  const env = { ...process.env, HOST: "127.0.0.1" };
  delete env.PORT;
  delete env.HTML_WORKBENCH_ADMIN_ORIGIN;
  delete env.HTML_WORKBENCH_PUBLIC_ORIGIN;
  const child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`fallback server did not start: ${stderr}`)), 3000);
      child.stdout.on("data", (chunk) => {
        const match = chunk.match(/http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      child.once("exit", (code) => reject(new Error(`fallback server exited with ${code}: ${stderr}`)));
    });
    const response = await request(`http://127.0.0.1:${port}`, "/healthz", {
      headers: { Host: `localhost:${port}` }
    });
    assert.equal(response.status, 200);
  } finally {
    if (child.exitCode === null) child.kill();
    await close(occupied);
  }
});

test("an explicit admin origin disables fallback when the default port is busy", async (t) => {
  const occupied = http.createServer();
  try {
    await new Promise((resolve, reject) => occupied.listen(3000, "127.0.0.1", resolve).once("error", reject));
  } catch (error) {
    t.skip(`port 3000 is unavailable: ${error.code || error.message}`);
    return;
  }

  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  };
  delete env.PORT;
  const child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const [code] = await Promise.race([
      once(child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("explicit origin did not disable fallback")), 1000))
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /EADDRINUSE/);
  } finally {
    if (child.exitCode === null) child.kill();
    await close(occupied);
  }
});
