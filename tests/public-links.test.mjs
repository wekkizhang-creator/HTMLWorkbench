import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { buildReplacementRecord, buildReplacementPackageRecord } from "../lib/records.mjs";

const code = "aB01234567";
const nextCode = "Zy98765432";
const origin = "https://ho.wekkii.cn";
const html = Buffer.from("<title>Example</title><p>Source</p>");
function record() {
  const id = randomUUID();
  return { id, uploadKind: "html", url: `/view/${id}`, originalName: "test.html",
    title: "Test", documentType: "Other", size: html.length, uploadedAt: new Date().toISOString() };
}

function zipFixture() {
  const name = Buffer.from("index.html");
  const body = Buffer.from("<h1>ZIP</h1>");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "public-links-"));
  const keys = ["HTML_WORKBENCH_DATA_DIR", "HTML_WORKBENCH_PUBLIC_ORIGIN", "BLOB_READ_WRITE_TOKEN", "VERCEL", "NODE_ENV"];
  const previous = keys.map(key => [key, process.env[key]]);
  process.env.HTML_WORKBENCH_DATA_DIR = directory;
  process.env.HTML_WORKBENCH_PUBLIC_ORIGIN = origin;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  process.env.NODE_ENV = "test";
  t.after(async () => {
    t.mock.restoreAll();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const storage = await import(`../lib/storage.mjs?public-links=${randomUUID()}`);
  return { directory, storage, async write(name, value) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  } };
}

function fakeBlob() {
  const entries = new Map();
  const writes = [];
  return { entries, writes,
    async put(name, body, options) {
      writes.push({ name, options });
      if (entries.has(name) && options.allowOverwrite === false) throw Object.assign(new Error("Already exists"), { status: 409 });
      entries.set(name, String(body));
      return { pathname: name };
    },
    async get(name, options) {
      assert.equal(options.useCache, false);
      return entries.has(name) ? { statusCode: 200, blob: { etag: "test-etag" }, stream: new Blob([entries.get(name)]).stream() } : null;
    },
    async del(names) { for (const name of Array.isArray(names) ? names : [names]) entries.delete(name); },
    async list() { throw new Error("Public link operations must not list storage"); }
  };
}

test("public helper contracts and code format", async t => {
  const links = await import("../lib/public-links.mjs").catch(() => ({}));
  const { storage } = await fixture(t);
  assert.equal(typeof storage.generatePublicCode, "function");
  for (let i = 0; i < 200; i++) assert.match(storage.generatePublicCode(), /^[A-Za-z0-9]{10}$/);
  assert.deepEqual(Object.keys(links).sort(), ["PUBLIC_VIEW_RE", "isPublicToken", "publicViewPath"]);
  const helperSource = await fs.readFile(new URL("../lib/public-links.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(helperSource, /\bimport\b|node:crypto/);
  const r = record();
  for (const token of [r.id, code]) {
    assert.equal(links.isPublicToken(token), true);
    assert.equal(links.PUBLIC_VIEW_RE.exec(`/view/${token}/assets/app.js`)[1], token);
  }
  for (const token of [null, 1234567890, "../escape", "a".repeat(11), "abcdefgh_1", `${code}\n`, `${r.id}\n`]) assert.equal(links.isPublicToken(token), false);
  assert.equal(links.publicViewPath(r), `/view/${r.id}`);
  assert.equal(links.publicViewPath({ ...r, publicCode: code }, "zip"), `/view/${code}/`);
});

for (const backend of ["local", "blob"]) {
  test(`${backend}: immutable reservations retry, exhaust and survive missing/deleted records`, async t => {
    const f = await fixture(t);
    assert.equal(typeof f.storage.assignPublicLink, "function");
    const blobSdk = backend === "blob" ? fakeBlob() : undefined;
    const options = { blobSdk };
    const first = await f.storage.assignPublicLink(record(), { ...options, generateCode: () => code });
    assert.equal(first.publicOrigin, origin);
    assert.equal(first.url, `${origin}/view/${code}`);
    assert.equal(await f.storage.getRecordByPublicToken(code, options), null);
    const mappingPath = `public-links/${code}.json`;
    const read = async name => blobSdk ? JSON.parse(blobSdk.entries.get(name)) : JSON.parse(await fs.readFile(path.join(f.directory, name), "utf8"));
    assert.deepEqual(await read(mappingPath), { version: 1, code, id: first.id });
    let calls = 0;
    await assert.rejects(f.storage.assignPublicLink(record(), { ...options, generateCode: () => { calls++; return code; } }), /collision/i);
    assert.equal(calls, 10);
    calls = 0;
    const second = await f.storage.assignPublicLink({ ...record(), uploadKind: "zip" }, { ...options, generateCode: () => ++calls === 1 ? code : nextCode });
    assert.equal(second.url, `${origin}/view/${nextCode}/`);
    assert.equal(calls, 2);
    const canonical = `records/${first.id}.json`;
    if (blobSdk) blobSdk.entries.set(canonical, JSON.stringify(first)); else await f.write(canonical, first);
    const before = blobSdk?.writes.length;
    assert.deepEqual(await f.storage.getRecordByPublicToken(code, options), first);
    assert.deepEqual(await f.storage.getRecordByPublicToken(first.id, options), first);
    if (blobSdk) {
      assert.equal(blobSdk.writes.length, before);
      blobSdk.entries.delete(canonical);
      assert.ok(blobSdk.writes.filter(w => w.name.startsWith("public-links/")).every(w => w.options.allowOverwrite === false));
    } else {
      await f.storage.deleteUpload(first);
    }
    assert.equal(await f.storage.getRecordByPublicToken(code, options), null);
    await assert.rejects(f.storage.assignPublicLink(record(), { ...options, generateCode: () => code }), /collision/i);
    assert.deepEqual(await read(mappingPath), { version: 1, code, id: first.id });
  });

  test(`${backend}: malformed mappings and canonical mismatches are read-only missing`, async t => {
    const f = await fixture(t);
    assert.equal(typeof f.storage.getRecordByPublicToken, "function");
    const blobSdk = backend === "blob" ? fakeBlob() : undefined;
    const options = { blobSdk };
    const write = async (name, value) => blobSdk ? blobSdk.entries.set(name, typeof value === "string" ? value : JSON.stringify(value)) : f.write(name, value);
    assert.equal(await f.storage.getRecordByPublicToken(code, options), null);
    if (!blobSdk) assert.deepEqual(await fs.readdir(f.directory), []);
    const r = { ...record(), publicCode: code };
    await write(`records/${r.id}.json`, r);
    for (const mapping of ["{bad", null, [], { version: 2, code, id: r.id }, { version: 1, code: nextCode, id: r.id }, { version: 1, code, id: "../escape" }]) {
      await write(`public-links/${code}.json`, mapping);
      assert.equal(await f.storage.getRecordByPublicToken(code, options), null);
    }
    await write(`public-links/${code}.json`, { version: 1, code, id: r.id });
    for (const canonical of ["{bad", { ...r, publicCode: nextCode }, { ...r, id: randomUUID() }, null]) {
      await write(`records/${r.id}.json`, canonical);
      assert.equal(await f.storage.getRecordByPublicToken(code, options), null);
    }
    assert.equal(await f.storage.getRecordByPublicToken("../escape", options), null);
    if (blobSdk) assert.equal(blobSdk.writes.length, 0);
  });
}

for (const backend of ["local", "blob"]) test(`${backend}: concurrent allocators serialize through the global writer lease`, async t => {
  const { storage } = await fixture(t);
  assert.equal(typeof storage.assignPublicLink, "function");
  const blobSdk = backend === "blob" ? fakeBlob() : undefined;
  const values = [code, code, nextCode];
  const results = await Promise.all([1, 2].map(() => storage.assignPublicLink(record(), { blobSdk, generateCode: () => values.shift() })));
  assert.equal(new Set(results.map(r => r.publicCode)).size, 2);
});

test("failed local reservation writes remain occupied forever", async t => {
  const f = await fixture(t);
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (name, ...args) => {
    const handle = await open(name, ...args);
    if (String(name).endsWith(`${code}.json`) && args[0] === "wx") {
      handle.writeFile = async () => { throw new Error("Injected reservation write failure"); };
    }
    return handle;
  });
  await assert.rejects(f.storage.assignPublicLink(record(), { generateCode: () => code }), /Injected/);
  t.mock.restoreAll();
  assert.equal(await fs.readFile(path.join(f.directory, `public-links/${code}.json`), "utf8"), "");
  assert.equal(await f.storage.getRecordByPublicToken(code), null);
  await assert.rejects(f.storage.assignPublicLink(record(), { generateCode: () => code }), /collision/);
});

test("ambiguous Blob acknowledgment leaves reservation occupied", async t => {
  const { storage } = await fixture(t);
  const blobSdk = fakeBlob();
  const put = blobSdk.put.bind(blobSdk);
  let fail = true;
  blobSdk.put = async (...args) => {
    const result = await put(...args);
    if (fail && args[0].startsWith("public-links/")) { fail = false; throw new Error("Lost acknowledgment"); }
    return result;
  };
  await assert.rejects(storage.assignPublicLink(record(), { blobSdk, generateCode: () => code }), /Lost acknowledgment/);
  await assert.rejects(storage.assignPublicLink(record(), { blobSdk, generateCode: () => code }), /collision/);
  assert.equal(await storage.getRecordByPublicToken(code, { blobSdk }), null);
});

test("existing records cannot acquire a new identity and invalid generators do not reserve", async t => {
  const { storage } = await fixture(t);
  const r = await storage.saveIndexedRecord(record());
  await assert.rejects(storage.assignPublicLink(r), /fresh upload/);
  await assert.rejects(storage.assignPublicLink({ ...record(), publicCode: code }), /fresh upload/);
  for (const value of ["../escape", "123", 1234567890, `${code}\n`]) {
    await assert.rejects(storage.assignPublicLink(record(), { generateCode: () => value }), /10 ASCII/);
  }
  assert.deepEqual(await storage.getRecord(r.id), r);
});

for (const identity of ["short", "legacy-relative", "legacy-absolute"]) {
  test(`${identity}: replacement, editor save and rollback retain identity`, async t => {
    const { storage } = await fixture(t);
    let r = record();
    if (identity === "short") r = { ...r, publicCode: code, publicOrigin: origin, url: `${origin}/view/${code}` };
    if (identity === "legacy-absolute") r.url = `https://page.wekki.fun/view/${r.id}`;
    const originalUrl = r.url;
    const uploadBlob = await storage.saveUpload(r.id, html);
    r = await storage.saveIndexedRecord({ ...r, blobPath: uploadBlob.pathname });
    const zip = buildReplacementPackageRecord({ record: r, indexBuffer: html, originalName: "test.zip", packageBlob: { pathname: "unused.zip" }, siteFiles: [], sourceSize: 5 });
    assert.equal(zip.url, `${originalUrl}/`);
    const replacement = buildReplacementRecord({ record: zip, fileBuffer: html, originalName: "test.html", uploadBlob });
    assert.equal(replacement.url, originalUrl);
    const edited = await storage.saveEditorReplacement(r, html, Buffer.from("<p>Edited</p>"));
    assert.equal(edited.url, originalUrl);
    assert.equal(edited.publicCode, r.publicCode);
    assert.equal(edited.publicOrigin, r.publicOrigin);
    const restored = await storage.restorePreviousVersion(edited);
    assert.equal(restored.url, originalUrl);
    assert.equal(restored.publicCode, r.publicCode);
    const previousVersion = await storage.savePreviousVersion(restored);
    const packageData = await storage.savePackageUpload(r.id, Buffer.from("package"), [{ pathname: "index.html", buffer: html, contentType: "text/html" }]);
    const savedZip = await storage.saveIndexedRecord(buildReplacementPackageRecord({ record: { ...restored, previousVersion }, indexBuffer: html,
      originalName: "test.zip", ...packageData, sourceSize: 7 }), restored);
    const rolledHtml = await storage.restorePreviousVersion(savedZip);
    assert.equal(rolledHtml.url, originalUrl);
    const zipAgain = await storage.saveIndexedRecord(buildReplacementPackageRecord({ record: rolledHtml, indexBuffer: html, originalName: "test.zip",
      ...await storage.savePackageUpload(r.id, Buffer.from("package"), [{ pathname: "index.html", buffer: html, contentType: "text/html" }]), sourceSize: 7 }), rolledHtml);
    const previousZip = await storage.savePreviousVersion(zipAgain);
    const htmlAgain = await storage.saveIndexedRecord(buildReplacementRecord({ record: { ...zipAgain, previousVersion: previousZip }, fileBuffer: html,
      originalName: "test.html", uploadBlob: await storage.saveUpload(r.id, html) }), zipAgain);
    const rolledZip = await storage.restorePreviousVersion(htmlAgain);
    assert.equal(rolledZip.url, `${originalUrl}/`);
    assert.equal(rolledZip.publicCode, r.publicCode);
    assert.equal(rolledZip.publicOrigin, r.publicOrigin);
  });
}

test("fresh HTML and ZIP POSTs receive absolute short links without touching old records", async t => {
  const { directory } = await fixture(t);
  const script = `
    import assert from 'node:assert/strict';
    import { POST } from './api/uploads.mjs';
    import { createAuthCookie, createCsrfToken } from './lib/auth.mjs';
    import { saveIndexedRecord, getRecord, getRecordByPublicToken } from './lib/storage.mjs';
    const old = await saveIndexedRecord(${JSON.stringify(record())});
    const cookie = createAuthCookie().split(';')[0];
    const bodies = [['test.html', Buffer.from('<h1>Hello</h1>')], ['test.zip', Buffer.from('${zipFixture().toString("base64")}', 'base64')]];
    for (const [name, body] of bodies) {
      const form = new FormData(); form.set('file', new File([body], name));
      const response = await POST(new Request('http://localhost:3000/api/uploads', { method: 'POST', body: form,
        headers: { origin: 'http://localhost:3000', cookie, 'x-csrf-token': createCsrfToken(cookie) } }));
      const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result));
      assert.match(result.record.url, /^https:\\/\\/ho\\.wekkii\\.cn\\/view\\/[A-Za-z0-9]{10}\\/?$/);
      const canonical = await getRecord(result.record.id);
      assert.equal(canonical.publicOrigin, '${origin}');
      assert.equal(canonical.url.endsWith('/'), name.endsWith('.zip'));
      assert.equal((await getRecordByPublicToken(canonical.publicCode)).id, canonical.id);
    }
    assert.deepEqual(await getRecord(old.id), old);
  `;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, HTML_WORKBENCH_DATA_DIR: directory, HTML_WORKBENCH_ROLE: "admin", HTML_WORKBENCH_ADMIN_ORIGIN: "http://localhost:3000" }
  });
});
