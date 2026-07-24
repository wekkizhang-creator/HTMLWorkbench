import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const TEST_RECORD_ID = "11111111-1111-4111-8111-111111111111";

async function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function importFresh(relativePath) {
  const fileUrl = pathToFileURL(path.resolve(path.dirname(import.meta.filename), relativePath));
  return import(`${fileUrl.href}?${Date.now()}-${Math.random()}`);
}

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function request(origin, pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), headers: res.headers, status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function startServer(env) {
  const port = await reservePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-runtime-"));
  await fs.mkdir(path.join(dataDir, "records"));
  await fs.mkdir(path.join(dataDir, "uploads"));
  await fs.writeFile(path.join(dataDir, "records", `${TEST_RECORD_ID}.json`), JSON.stringify({
    id: TEST_RECORD_ID,
    originalName: "test.html",
    title: "Test",
    uploadKind: "html",
    blobPath: `uploads/${TEST_RECORD_ID}.html`,
    url: `/view/${TEST_RECORD_ID}`
  }));
  await fs.writeFile(path.join(dataDir, "uploads", `${TEST_RECORD_ID}.html`), "<main>public content</main>");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, HTML_WORKBENCH_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const origin = `http://127.0.0.1:${port}`;
  const host = new URL(env.HTML_WORKBENCH_PUBLIC_ORIGIN || env.HTML_WORKBENCH_ADMIN_ORIGIN).host;

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
      try {
        await request(origin, "/healthz", host);
        return {
          origin,
          close: async () => {
            if (child.exitCode === null) await new Promise((resolve) => {
              child.once("exit", resolve);
              child.kill();
            });
            await fs.rm(dataDir, { force: true, recursive: true });
          }
        };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("server startup timed out");
  } catch (error) {
    if (child.exitCode === null) child.kill();
    await fs.rm(dataDir, { force: true, recursive: true });
    throw error;
  }
}

test("public records use the configured public origin", async () => {
  await withEnv({ HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun" }, async () => {
    const { publicRecord } = await importFresh("../lib/records.mjs");
    assert.equal(
      publicRecord({ id: TEST_RECORD_ID, url: `/view/${TEST_RECORD_ID}` }).url,
      `https://page.wekki.fun/view/${TEST_RECORD_ID}`
    );
  });
});

test("runtime configuration recognizes role hosts and role routes", async () => {
  await withEnv({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun",
    HTML_WORKBENCH_ROLE: "content",
    HOST: "127.0.0.1",
    PORT: "3001"
  }, async () => {
    const { getRuntimeConfig, isAllowedHost, isRouteAllowed } = await importFresh("../lib/runtime.mjs");
    assert.deepEqual(getRuntimeConfig(), {
      role: "content",
      host: "127.0.0.1",
      port: 3001,
      adminOrigin: "https://ho.wekki.fun",
      publicOrigin: "https://page.wekki.fun"
    });
    assert.equal(isAllowedHost("page.wekki.fun", "content"), true);
    assert.equal(isAllowedHost("ho.wekki.fun", "content"), false);
    assert.equal(isRouteAllowed("content", `/view/${TEST_RECORD_ID}`), true);
    assert.equal(isRouteAllowed("content", "/api/uploads"), false);
  });
});

test("content role exposes view routes but rejects admin APIs", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ROLE: "content",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    assert.equal((await request(server.origin, "/api/uploads", "page.wekki.fun")).status, 404);
    assert.equal((await request(server.origin, `/view/${TEST_RECORD_ID}`, "page.wekki.fun")).status, 200);
    assert.equal((await request(server.origin, `/view/${TEST_RECORD_ID}`, "ho.wekki.fun")).status, 421);
  } finally {
    await server.close();
  }
});

test("admin role redirects legacy view paths without losing suffix or query", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const response = await request(server.origin, `/view/${TEST_RECORD_ID}/assets/app.js?v=2`, "ho.wekki.fun");
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.location,
      `https://page.wekki.fun/view/${TEST_RECORD_ID}/assets/app.js?v=2`
    );
  } finally {
    await server.close();
  }
});
