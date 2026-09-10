import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const TEST_ID = "11111111-1111-4111-8111-111111111111";

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

function request(origin, method, pathname, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, {
      headers: { Host: host, ...headers },
      method
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
          status: res.statusCode
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

async function startServer(env) {
  const port = await reservePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-editor-api-"));
  await fs.mkdir(path.join(dataDir, "record-index-state"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "uploads"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "record-index-state", "v1-ready.json"), JSON.stringify({
    completedAt: new Date().toISOString(),
    generation: "test",
    version: 1
  }));
  await fs.writeFile(path.join(dataDir, "records", `${TEST_ID}.json`), JSON.stringify({
    blobPath: `uploads/${TEST_ID}.html`,
    documentType: "Other",
    id: TEST_ID,
    originalName: "test.html",
    recordPath: `records/${TEST_ID}.json`,
    size: 22,
    title: "Original title",
    uploadedAt: "2026-09-11T00:00:00.000Z",
    uploadKind: "html",
    url: `/view/${TEST_ID}`
  }));
  await fs.writeFile(path.join(dataDir, "uploads", `${TEST_ID}.html`), "<!doctype html><h1>Original</h1>");

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      HTML_WORKBENCH_AUTH_SECRET: "editor-api-test-auth-secret",
      HTML_WORKBENCH_CURSOR_SECRET: "editor-api-test-cursor-secret",
      HTML_WORKBENCH_DATA_DIR: dataDir,
      HTML_WORKBENCH_PASSWORD: "885688",
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const origin = `http://127.0.0.1:${port}`;
  const activeOrigin = env.HTML_WORKBENCH_ROLE === "content"
    ? env.HTML_WORKBENCH_PUBLIC_ORIGIN
    : env.HTML_WORKBENCH_ADMIN_ORIGIN;
  const host = new URL(activeOrigin).host;

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
      try {
        await request(origin, "GET", "/healthz", { host });
        return {
          host,
          origin,
          async close() {
            if (child.exitCode === null) {
              await new Promise((resolve) => {
                child.once("exit", resolve);
                child.kill();
              });
            }
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

async function authorizedRequest(server, method, pathname, options = {}) {
  const login = await request(server.origin, "POST", "/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    host: server.host
  });
  assert.equal(login.status, 200);
  const cookie = cookieHeader(login.headers["set-cookie"]);
  const session = await request(server.origin, "GET", "/api/auth", {
    headers: { Cookie: cookie },
    host: server.host
  });
  const { csrfToken } = JSON.parse(session.body);
  const response = await request(server.origin, method, pathname, {
    body: options.body,
    headers: {
      Cookie: cookie,
      Origin: "https://ho.wekki.fun",
      "X-CSRF-Token": csrfToken,
      ...options.headers
    },
    host: server.host
  });
  return {
    ...response,
    json: response.body ? JSON.parse(response.body) : null
  };
}

test("editor versions change with record state or content", async () => {
  const { createEditorVersion } = await importFresh("../lib/editor-content.mjs");
  const record = { id: TEST_ID, uploadedAt: "2026-09-11T00:00:00.000Z" };
  assert.notEqual(
    createEditorVersion(record, Buffer.from("<h1>A</h1>")),
    createEditorVersion(record, Buffer.from("<h1>B</h1>"))
  );
  assert.notEqual(
    createEditorVersion(record, Buffer.from("<h1>A</h1>")),
    createEditorVersion({ ...record, uploadedAt: "2026-09-12T00:00:00.000Z" }, Buffer.from("<h1>A</h1>"))
  );
});

test("editor helper permits HTML records and rejects missing or ZIP records", async () => {
  const { assertEditableRecord } = await importFresh("../lib/editor-content.mjs");
  assert.equal(assertEditableRecord({ uploadKind: "html" }).uploadKind, "html");
  assert.throws(() => assertEditableRecord(null), { status: 404 });
  assert.throws(() => assertEditableRecord({ uploadKind: "zip" }), { status: 409 });
});

test("content role rejects editor source routes", async () => {
  const contentServer = await startServer({
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun",
    HTML_WORKBENCH_ROLE: "content"
  });
  try {
    const response = await request(contentServer.origin, "GET", `/api/uploads/${TEST_ID}/content`, {
      host: contentServer.host
    });
    assert.equal(response.status, 404);
  } finally {
    await contentServer.close();
  }
});

test("editor source writes require an If-Match version", async () => {
  const adminServer = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const response = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "<!doctype html><h1>Edited</h1>",
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
    assert.equal(response.status, 428);
  } finally {
    await adminServer.close();
  }
});

test("editor source writes reject non-HTML and empty bodies", async () => {
  const adminServer = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const unsupportedType = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "plain text",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "If-Match": '"current"'
      }
    });
    assert.equal(unsupportedType.status, 415);

    const lookalikeType = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "<h1>Not HTML</h1>",
      headers: {
        "Content-Type": "text/html-source",
        "If-Match": '"current"'
      }
    });
    assert.equal(lookalikeType.status, 415);

    const empty = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "If-Match": '"current"'
      }
    });
    assert.equal(empty.status, 400);
  } finally {
    await adminServer.close();
  }
});

test("editor source writes reject bodies over the upload limit", async () => {
  const adminServer = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const response = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: Buffer.alloc(30 * 1024 * 1024 + 1, " "),
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "If-Match": '"current"'
      }
    });
    assert.equal(response.status, 413);
  } finally {
    await adminServer.close();
  }
});

test("admin editor page redirects an unauthenticated visitor to login", async () => {
  const adminServer = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const response = await request(adminServer.origin, "GET", "/editor.html?upload=test", {
      host: adminServer.host
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "/login.html?next=%2Feditor.html%3Fupload%3Dtest");
  } finally {
    await adminServer.close();
  }
});

test("admin editor API reads, saves and detects stale versions", async () => {
  const adminServer = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const first = await authorizedRequest(adminServer, "GET", `/api/uploads/${TEST_ID}/content`);
    assert.equal(first.status, 200);
    assert.equal(first.json.html, "<!doctype html><h1>Original</h1>");
    assert.equal(first.headers.etag, first.json.version);
    assert.equal(first.json.record.title, "Original title");

    const saved = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "<!doctype html><h1>Edited</h1>",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "If-Match": first.headers.etag
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.record.title, "Original title");
    assert.notEqual(saved.json.version, first.headers.etag);

    const stale = await authorizedRequest(adminServer, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "<h1>Stale</h1>",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "If-Match": first.headers.etag
      }
    });
    assert.equal(stale.status, 409);
  } finally {
    await adminServer.close();
  }
});
