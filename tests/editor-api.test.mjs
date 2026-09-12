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
          dataDir,
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
      ...(options.omitOrigin ? {} : { Origin: "https://ho.wekki.fun" }),
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

test("editor source accepts authenticated same-origin browser GET without Origin", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const response = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`, {
      omitOrigin: true, headers: { "Sec-Fetch-Site": "same-origin" }
    });
    assert.equal(response.status, 200);
    assert.match(response.json.html, /Original/);
    const unauthenticated = await request(server.origin, "GET", `/api/uploads/${TEST_ID}/content`, {
      host: server.host, headers: { "Sec-Fetch-Site": "same-origin" }
    });
    assert.equal(unauthenticated.status, 401);
  } finally { await server.close(); }
});

test("Origin-free editor GET exception rejects other sites and never applies to writes", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    for (const site of ["same-site", "cross-site", "none", ""]) {
      const response = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`, {
        omitOrigin: true, headers: { "Sec-Fetch-Site": site }
      });
      assert.equal(response.status, 403, site);
    }
    const conflictingOrigin = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`, {
      headers: { Origin: "https://page.wekki.fun", "Sec-Fetch-Site": "same-origin" }
    });
    assert.equal(conflictingOrigin.status, 403);
    const write = await authorizedRequest(server, "PUT", `/api/uploads/${TEST_ID}/content`, {
      omitOrigin: true, body: "<h1>Rejected</h1>",
      headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/html", "If-Match": '"anything"' }
    });
    assert.equal(write.status, 403);
  } finally { await server.close(); }
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

test("failed editor index write preserves source, metadata and the existing rollback slot", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  try {
    const recordPath = path.join(server.dataDir, "records", `${TEST_ID}.json`);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    record.previousVersion = { ...record, blobPath: `uploads/${TEST_ID}/previous/upload.html` };
    await fs.mkdir(path.join(server.dataDir, "uploads", TEST_ID, "previous"), { recursive: true });
    await fs.writeFile(path.join(server.dataDir, record.previousVersion.blobPath), "<h1>Prior rollback</h1>");
    await fs.writeFile(recordPath, JSON.stringify(record));
    const before = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`);
    // A file where the index directory belongs injects a real storage failure.
    await fs.writeFile(path.join(server.dataDir, "record-index"), "blocked");
    const failed = await authorizedRequest(server, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: "<h1>Must not publish</h1>",
      headers: { "Content-Type": "text/html", "If-Match": before.json.version }
    });
    assert.equal(failed.status, 500);
    const after = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`);
    assert.equal(after.status, 200);
    assert.equal(after.json.html, before.json.html);
    assert.equal(after.json.version, before.json.version);
    assert.deepEqual(JSON.parse(await fs.readFile(recordPath, "utf8")), record);
    assert.equal(await fs.readFile(path.join(server.dataDir, record.previousVersion.blobPath), "utf8"), "<h1>Prior rollback</h1>");
  } finally { await server.close(); }
});

test("editor save updates the public URL and rollback restores original source", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  const port = await reservePort();
  const content = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, HTML_WORKBENCH_ROLE: "content", HTML_WORKBENCH_DATA_DIR: server.dataDir,
      HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun", HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  const publicOrigin = `http://127.0.0.1:${port}`;
  try {
    const original = '<!doctype html><html><head><style>h1{color:red}</style></head><body><h1 data-business="keep">原始文案</h1><script>window.example=1;</script></body></html>';
    await fs.writeFile(path.join(server.dataDir, "uploads", `${TEST_ID}.html`), original);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await request(publicOrigin, "GET", "/healthz", { host: "page.wekki.fun" });
        if (response.status === 200) { ready = true; break; }
      } catch { /* The child may not have bound its port yet. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, "content server starts");
    const first = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`);
    const edited = original.replace("原始文案", "修改后的文案");
    const saved = await authorizedRequest(server, "PUT", `/api/uploads/${TEST_ID}/content`, {
      body: edited, headers: { "Content-Type": "text/html", "If-Match": first.json.version }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.record.url, first.json.record.url);
    assert.equal(saved.json.record.hasPreviousVersion, true);
    const published = await request(publicOrigin, "GET", `/view/${TEST_ID}`, { host: "page.wekki.fun" });
    assert.equal(published.status, 200);
    assert.ok(published.body.includes("修改后的文案"));
    assert.ok(published.body.includes('<script>window.example=1;</script>'));
    const rollback = await authorizedRequest(server, "PATCH", `/api/uploads/${TEST_ID}`);
    assert.equal(rollback.status, 200);
    const restored = await authorizedRequest(server, "GET", `/api/uploads/${TEST_ID}/content`);
    assert.equal(restored.json.html, original);
    assert.equal(restored.json.record.hasPreviousVersion, false);
    const publicRestored = await request(publicOrigin, "GET", `/view/${TEST_ID}`, { host: "page.wekki.fun" });
    assert.ok(publicRestored.body.includes("原始文案"));
    assert.ok(!publicRestored.body.includes("修改后的文案"));
  } finally {
    if (content.exitCode === null) await new Promise(resolve => { content.once("exit", resolve); content.kill(); });
    await server.close();
  }
});
