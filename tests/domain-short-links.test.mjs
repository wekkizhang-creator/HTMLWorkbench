import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRecordIndexPath } from "../lib/record-index.mjs";

const oldId = "22222222-2222-4222-8222-222222222222";
const oldHtml = "<!doctype html><title>Legacy</title><h1>Legacy file</h1>";
const newHtml = '<!doctype html><html><head><title>New file</title></head><body><h1 id="heading">New file</h1><script>window.originalSource=true;</script></body></html>';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: target.port, path: target.pathname + target.search, method, headers: { Host: target.host, ...headers } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function sendFile(url, content, name, headers, method = "POST") {
  const form = new FormData();
  form.set("file", new File([content], name));
  form.set("title", "Link identity test");
  const encoded = new Request(url, { method, body: form });
  return request(url, { method, headers: { ...headers, "Content-Type": encoded.headers.get("content-type") }, body: Buffer.from(await encoded.arrayBuffer()) });
}

// Small uncompressed ZIP fixture; production ZIP logic is exercised through upload APIs.
function zipFixture() {
  const entries = [
    ["index.html", '<!doctype html><html><head><title>ZIP</title><link rel="stylesheet" href="assets/site.css"></head><body><h1>ZIP file</h1><a href="sub/page.html">Nested</a></body></html>'],
    ["assets/site.css", "h1{color:rgb(1,2,3)}"],
    ["sub/page.html", "<!doctype html><html><head><title>Nested</title></head><body>Nested page</body></html>"]
  ];
  const localParts = [], directoryParts = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), body = Buffer.from(text);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    localParts.push(local, filename, body); directoryParts.push(central, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

test("domain migration preserves old files and gives only new uploads durable short links", { timeout: 90000 }, async t => {
  const adminPort = await freePort(), contentPort = await freePort();
  const admin = `http://desk.localhost:${adminPort}`, content = `http://new-page.localhost:${contentPort}`;
  const legacyAdmin = `http://old-desk.localhost:${adminPort}`, legacyContent = `http://old-page.localhost:${contentPort}`;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hwb-domains-"));
  const legacy = { id: oldId, originalName: "legacy.html", title: "Legacy", uploadKind: "html", documentType: "Other", uploadedAt: "2026-09-12T00:00:00.000Z", url: `/view/${oldId}`, blobPath: `uploads/${oldId}.html`, recordPath: `records/${oldId}.json`, size: Buffer.byteLength(oldHtml) };
  const indexPath = buildRecordIndexPath(legacy);
  for (const folder of ["records", "uploads", "record-index/v1", "record-index-state"]) await fs.mkdir(path.join(dataDir, folder), { recursive: true });
  const legacyBytes = JSON.stringify(legacy);
  await fs.writeFile(path.join(dataDir, legacy.recordPath), legacyBytes);
  await fs.writeFile(path.join(dataDir, legacy.blobPath), oldHtml);
  await fs.writeFile(path.join(dataDir, indexPath), JSON.stringify({ indexPath, recordPath: legacy.recordPath, record: { ...legacy, url: legacyContent + legacy.url } }));
  await fs.writeFile(path.join(dataDir, "record-index-state/v1-ready.json"), JSON.stringify({ version: 1, generation: "fixture", completedAt: new Date().toISOString() }));
  const password = randomBytes(16).toString("hex");
  const environment = {
    ...process.env, NODE_ENV: "development", VERCEL: "0", VERCEL_ENV: "development", BLOB_READ_WRITE_TOKEN: "", HOST: "127.0.0.1",
    HTML_WORKBENCH_ADMIN_ORIGIN: admin, HTML_WORKBENCH_PUBLIC_ORIGIN: content,
    HTML_WORKBENCH_LEGACY_ADMIN_ORIGIN: legacyAdmin, HTML_WORKBENCH_LEGACY_PUBLIC_ORIGIN: legacyContent,
    HTML_WORKBENCH_PASSWORD: password, HTML_WORKBENCH_DOWNLOAD_PASSWORD: password,
    HTML_WORKBENCH_AUTH_SECRET: randomBytes(32).toString("hex"), HTML_WORKBENCH_CURSOR_SECRET: randomBytes(32).toString("hex"), HTML_WORKBENCH_DATA_DIR: dataDir
  };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  for (const [role, port, origin] of [["admin", adminPort, admin], ["content", contentPort, content]]) {
    const child = spawn(process.execPath, ["server.js"], { env: { ...environment, PORT: String(port), HTML_WORKBENCH_ROLE: role }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, `server stopped: ${stderr}`);
      try { if ((await request(`${origin}/healthz`)).status === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `${role} readiness: ${stderr}`);
  }
  const loggedIn = await request(`${admin}/api/auth`, { method: "POST", headers: { Origin: admin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.headers["set-cookie"][0].split(";", 1)[0];
  const session = await request(`${admin}/api/auth`, { headers: { Cookie: cookie } });
  const headers = { Cookie: cookie, Origin: admin, "X-CSRF-Token": JSON.parse(session.body).csrfToken };
  let fresh;

  await t.test("legacy bytes, URLs, download widgets and isolation stay intact", async () => {
    const listed = JSON.parse((await request(`${admin}/api/uploads`, { headers })).body).records;
    assert.equal(listed.find(record => record.id === oldId).url, legacyContent + legacy.url);
    const old = await request(legacyContent + legacy.url);
    assert.equal(old.status, 200); assert.match(old.body, /Legacy file/); assert.ok(old.body.includes(`${admin}/public-download-widget/${oldId}`));
    assert.equal(await fs.readFile(path.join(dataDir, legacy.recordPath), "utf8"), legacyBytes);
    assert.equal(await fs.readFile(path.join(dataDir, legacy.blobPath), "utf8"), oldHtml);
    const widget = await request(`${admin}/public-download-widget/${oldId}`);
    assert.equal(widget.headers["content-security-policy"], `frame-ancestors ${content} ${legacyContent}`);
    for (const origin of [content, legacyContent]) {
      for (const route of ["/api/auth", "/api/uploads", "/editor.html", `/public-download-widget/${oldId}`]) assert.equal((await request(origin + route, { headers })).status, 404);
      assert.equal((await request(`${admin}/api/auth`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) })).status, 403);
    }
    const redirected = await request(`${legacyAdmin}/editor.html?id=${oldId}`);
    assert.equal(redirected.status, 307); assert.equal(redirected.headers.location, `${admin}/editor.html?id=${oldId}`);
    assert.equal((await request(`${legacyAdmin}/api/auth`, { method: "POST", headers, body: "{}" })).status, 404);
  });

  await t.test("new HTML upload gets a short link that survives editing, replacement and rollback", async () => {
    const upload = await sendFile(`${admin}/api/uploads`, newHtml, "new.html", headers);
    assert.equal(upload.status, 201, upload.body); fresh = JSON.parse(upload.body).record;
    assert.match(fresh.id, /^[0-9a-f-]{36}$/);
    assert.equal(new URL(fresh.url).origin, content); assert.match(new URL(fresh.url).pathname, /^\/view\/[A-Za-z0-9]{10}$/);
    assert.match((await request(fresh.url)).body, /New file/);
    const saved = await request(`${admin}/api/uploads/${fresh.id}/content`, { headers });
    assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.body).record.url, fresh.url);
    const edited = await request(`${admin}/api/uploads/${fresh.id}/content`, { method: "PUT", headers: { ...headers, "Content-Type": "text/html", "If-Match": saved.headers.etag }, body: newHtml.replace("New file</h1>", "Edited file</h1>") });
    assert.equal(edited.status, 200, edited.body); assert.equal(JSON.parse(edited.body).record.url, fresh.url);
    assert.match((await request(fresh.url)).body, /Edited file/);
    const rollback = await request(`${admin}/api/uploads/${fresh.id}`, { method: "PATCH", headers });
    assert.equal(rollback.status, 200, rollback.body); assert.equal(JSON.parse(rollback.body).record.url, fresh.url);
    assert.equal(JSON.parse((await request(`${admin}/api/uploads/${fresh.id}/content`, { headers })).body).html, newHtml);
    const replacement = await sendFile(`${admin}/api/uploads/${fresh.id}`, newHtml.replaceAll("New file", "Replacement"), "replace.html", headers, "PUT");
    assert.equal(replacement.status, 200, replacement.body); assert.equal(JSON.parse(replacement.body).record.url, fresh.url);
    assert.equal((await request(`${admin}/api/uploads/${fresh.id}`, { method: "PATCH", headers })).status, 200);
    assert.equal(await fs.readFile(path.join(dataDir, legacy.recordPath), "utf8"), legacyBytes);
  });

  await t.test("new ZIP links and nested assets retain the short base across type replacements", async () => {
    const uploaded = await sendFile(`${admin}/api/uploads`, zipFixture(), "site.zip", headers);
    assert.equal(uploaded.status, 201, uploaded.body);
    const zip = JSON.parse(uploaded.body).record, pathname = new URL(zip.url).pathname;
    assert.match(pathname, /^\/view\/[A-Za-z0-9]{10}\/$/);
    const root = await request(zip.url); assert.equal(root.status, 200); assert.ok(root.body.includes(`<base href="${pathname}">`));
    const asset = await request(zip.url + "assets/site.css"); assert.equal(asset.status, 200); assert.equal(asset.body, "h1{color:rgb(1,2,3)}");
    const nested = await request(zip.url + "sub/page.html"); assert.equal(nested.status, 200); assert.ok(nested.body.includes(`<base href="${pathname}">`));
    const replacement = await sendFile(`${admin}/api/uploads/${zip.id}`, newHtml, "replace.html", headers, "PUT");
    assert.equal(replacement.status, 200, replacement.body); assert.equal(JSON.parse(replacement.body).record.url, zip.url.slice(0, -1));
    const rolled = await request(`${admin}/api/uploads/${zip.id}`, { method: "PATCH", headers });
    assert.equal(rolled.status, 200, rolled.body); assert.equal(JSON.parse(rolled.body).record.url, zip.url);
    assert.equal((await request(zip.url + "assets/site.css")).status, 200);
    assert.equal((await request(`${admin}/api/uploads/${zip.id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await request(zip.url)).status, 404);
    assert.equal((await request(zip.url + "assets/site.css")).status, 404);
  });

  await t.test("legacy replacement remains a UUID on the legacy origin", async () => {
    const changed = await sendFile(`${admin}/api/uploads/${oldId}`, newHtml, "legacy-replacement.html", headers, "PUT");
    assert.equal(changed.status, 200, changed.body); assert.equal(JSON.parse(changed.body).record.url, legacyContent + legacy.url);
    const restored = await request(`${admin}/api/uploads/${oldId}`, { method: "PATCH", headers });
    assert.equal(restored.status, 200, restored.body); assert.equal(JSON.parse(restored.body).record.url, legacyContent + legacy.url);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, legacy.recordPath), "utf8"));
    assert.equal(persisted.publicCode, undefined); assert.equal(persisted.publicOrigin, undefined);
    assert.equal((await request(legacyContent + legacy.url)).status, 200);
  });

  await t.test("browser uses the new short URL for preview and edits on both viewport sizes", { skip: !process.env.EDITOR_PLAYWRIGHT_MODULE }, async () => {
    const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const split = cookie.indexOf("=");
      for (const width of [1440, 390]) {
        // Isolate viewport runs from the public page's existing 60-second cache.
        const context = await browser.newContext({ viewport: { width, height: 960 } });
        await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: admin, httpOnly: true, sameSite: "Strict" }]);
        const page = await context.newPage(); page.setDefaultTimeout(10000);
        await page.goto(`${legacyAdmin}/editor.html?id=${fresh.id}`);
        await page.waitForURL(`${admin}/editor.html?id=${fresh.id}`);
        await page.locator("#loadState").waitFor({ state: "hidden" });
        const frame = page.frameLocator("#editorCanvas");
        assert.equal(await frame.locator("body").evaluate(el => el.ownerDocument.defaultView.originalSource), undefined);
        assert.equal(await frame.locator("body").evaluate(el => el.ownerDocument.baseURI), fresh.url);
        await frame.locator("#heading").dblclick(); await frame.locator("#heading").fill(`Browser ${width}`);
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.querySelector("#saveState").dataset.dirty === "false");
        const popupPromise = page.waitForEvent("popup"); await page.locator("#previewButton").click();
        const popup = await popupPromise; await popup.waitForLoadState();
        assert.ok(JSON.parse((await request(`${admin}/api/uploads/${fresh.id}/content`, { headers })).body).html.includes(`Browser ${width}`));
        assert.equal(popup.url(), fresh.url); assert.equal(await popup.locator("#heading").textContent(), `Browser ${width}`);
        assert.equal(await popup.evaluate(() => window.originalSource), true);
        await context.close();
      }
    } finally { await browser.close(); }
  });

  await t.test("deleting a new record leaves a reserved but nonresolving code", async () => {
    assert.ok(fresh);
    const code = new URL(fresh.url).pathname.split("/").pop();
    assert.equal((await request(`${admin}/api/uploads/${fresh.id}`, { method: "DELETE", headers })).status, 200);
    assert.equal((await request(fresh.url)).status, 404);
    const reservation = JSON.parse(await fs.readFile(path.join(dataDir, `public-links/${code}.json`), "utf8"));
    assert.equal(reservation.id, fresh.id);
  });
});
