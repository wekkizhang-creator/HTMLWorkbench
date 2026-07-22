import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withServer(run) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTML_WORKBENCH_DATA_DIR: `${process.cwd()}/data-test`,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server startup timed out")), 5000);
    child.once("exit", (code) => reject(new Error(`server exited with code ${code}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("已启动")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("static text assets support gzip and conditional requests", async () => {
  await withServer(async (origin) => {
    const first = await fetch(`${origin}/styles.css`, {
      headers: { "Accept-Encoding": "gzip" }
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-encoding"), "gzip");
    assert.match(first.headers.get("cache-control") || "", /max-age=/);
    assert.equal(first.headers.get("vary"), "Accept-Encoding");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.match(await first.text(), /:root/);

    const cached = await fetch(`${origin}/styles.css`, {
      headers: { "If-None-Match": etag }
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  });
});

test("HEAD returns static headers without a response body", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/app.js`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("etag"));
    assert.equal(await response.text(), "");
  });
});
