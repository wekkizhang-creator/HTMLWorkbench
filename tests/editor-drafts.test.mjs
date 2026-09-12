import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";

const moduleUrl = new URL("../public/editor-drafts.mjs", import.meta.url);
const draftModule = await import(moduleUrl).catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const entry = (changes = {}) => ({ documentId: "doc", ownerId: "tab", baseVersion: '"v1"',
  html: "<p>Draft</p>", title: "Draft", pageIndex: 0, updatedAt: NOW, ...changes });
function store(options = {}) {
  assert.equal(typeof draftModule.createDraftStore, "function", "createDraftStore export must exist");
  return draftModule.createDraftStore({ now: () => NOW, ...options });
}

test("exports only createDraftStore; close is safe without opening", () => {
  assert.deepEqual(Object.keys(draftModule), ["createDraftStore"]);
  const drafts = store({ indexedDB: null });
  assert.deepEqual(Object.keys(drafts).sort(), ["close", "list", "remove", "write"]);
  drafts.close();
  drafts.close();
});

test("validates every input before touching IndexedDB, without leaking source", async () => {
  let opens = 0;
  const drafts = store({ indexedDB: { open() { opens++; throw Error("unexpected open"); } } });
  const invalid = [null, [], {}, ...["documentId", "ownerId", "baseVersion"].flatMap((field) =>
    ["", "  ", 1, null].map((value) => entry({ [field]: value }))),
  ...[null, 1].map((title) => entry({ title })),
  ...[-1, 0.5, NaN, Infinity, "0"].map((pageIndex) => entry({ pageIndex })),
  ...[NaN, Infinity, "1", null, NOW + 60_001].map((updatedAt) => entry({ updatedAt })),
  ...["", 42, null, "\u4e2d".repeat(10 * 1024 * 1024 + 1)].map((html) => entry({ html }))];
  for (const value of invalid) {
    await assert.rejects(drafts.write(value), { name: "TypeError" });
  }
  for (const id of ["", " ", null, 1]) {
    await assert.rejects(drafts.list(id), TypeError);
    await assert.rejects(drafts.remove("doc", id), TypeError);
    await assert.rejects(drafts.remove(id, "tab"), TypeError);
  }
  for (const stamp of [null, NaN, Infinity, "1", NOW + 60_001]) {
    await assert.rejects(drafts.remove("doc", "tab", stamp), TypeError);
  }
  await assert.rejects(drafts.write(entry({ pageIndex: -1, html: "SECRET_SOURCE" })),
    (error) => !error.message.includes("SECRET_SOURCE"));
  assert.equal(opens, 0);
});

test("unavailable and denied databases reject clearly and remain retryable", async () => {
  const unavailable = store({ indexedDB: null });
  await assert.rejects(unavailable.list("doc"), /draft.*unavailable/i);
  await assert.rejects(unavailable.write(entry()), /draft.*unavailable/i);
  await assert.rejects(unavailable.remove("doc", "tab"), /draft.*unavailable/i);
  let attempts = 0;
  const denied = store({ indexedDB: { open() {
    attempts++;
    throw new DOMException("denied", "SecurityError");
  } } });
  await assert.rejects(denied.list("doc"), /SecurityError/);
  await assert.rejects(denied.list("doc"), /SecurityError/);
  assert.equal(attempts, 2);
});

test("blocked opens reject within two seconds, close late connections, and retry", async () => {
  const requests = [];
  let closed = 0;
  const drafts = store({ indexedDB: { open() {
    const request = {};
    requests.push(request);
    queueMicrotask(() => request.onblocked?.());
    return request;
  } } });
  const started = performance.now();
  await assert.rejects(drafts.list("doc"), /blocked/i);
  assert.ok(performance.now() - started < 2000);
  requests[0].result = { close() { closed++; } };
  requests[0].onsuccess();
  assert.equal(closed, 1);
  await assert.rejects(drafts.list("doc"), /blocked/i);
  assert.equal(requests.length, 2);
});

test("silent opens time out; close cancels a pending open and closes its late result", async () => {
  const requests = [];
  const drafts = store({ indexedDB: { open() { const req = {}; requests.push(req); return req; } } });
  const started = performance.now();
  await assert.rejects(drafts.list("doc"), /timed out/i);
  assert.ok(performance.now() - started < 2000);
  const pending = drafts.list("doc");
  drafts.close();
  await assert.rejects(pending, /closed/i);
  let closed = false;
  requests.at(-1).result = { close() { closed = true; } };
  requests.at(-1).onsuccess();
  assert.equal(closed, true);
});

test("real Chrome IndexedDB draft storage", { skip: !process.env.EDITOR_PLAYWRIGHT_MODULE }, async (t) => {
  const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
  const source = await readFile(moduleUrl, "utf8");
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/editor-drafts.mjs" ? "text/javascript" : "text/html");
    res.end(req.url === "/editor-drafts.mjs" ? source : "<!doctype html><title>Draft storage fixture</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async ({ NOW, DAY }) => {
    const { createDraftStore } = await import("/editor-drafts.mjs");
    Object.assign(window, { NOW, DAY, createDraftStore });
    window.fixture = (changes = {}) => ({ documentId: "doc", ownerId: "tab", baseVersion: '"v1"',
      html: "<script>window.draftExecuted = true;</script><p>Draft</p>", title: "Draft", pageIndex: 0,
      updatedAt: NOW, ...changes });
    window.openRaw = () => new Promise((resolve, reject) => {
      const request = indexedDB.open("hwb-editor-drafts", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.drafts = createDraftStore({ now: () => NOW });
  }, { NOW, DAY });

  await t.test("compound schema, exact-document isolation, newest order and inert source", async () => {
    const result = await page.evaluate(async () => {
      await drafts.write(fixture());
      await drafts.write(fixture({ ownerId: "other", updatedAt: NOW + 1 }));
      await drafts.write(fixture({ documentId: "doc-extra" }));
      const db = await openRaw();
      const tx = db.transaction("drafts", "readonly");
      const objectStore = tx.objectStore("drafts");
      const keyPath = objectStore.keyPath;
      const record = await new Promise((resolve) => {
        const request = objectStore.get(["doc", "tab"]);
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return { keyPath, schema: record.schemaVersion, list: await drafts.list("doc"),
        missing: await drafts.list("missing"), executed: window.draftExecuted === true };
    });
    assert.deepEqual(result.keyPath, ["documentId", "ownerId"]);
    assert.equal(result.schema, 1);
    assert.deepEqual(result.list.map((value) => value.ownerId), ["other", "tab"]);
    assert.deepEqual(Object.keys(result.list[0]).sort(), Object.keys(entry()).sort());
    assert.equal(result.list[0].html, "<script>window.draftExecuted = true;</script><p>Draft</p>");
    assert.deepEqual(result.missing, []);
    assert.equal(result.executed, false);
  });

  await t.test("stale writes and conditional removal are atomic across connections", async () => {
    const result = await page.evaluate(async () => {
      const second = createDraftStore({ now: () => NOW });
      const outcomes = await Promise.all([
        drafts.write(fixture({ updatedAt: NOW + 30 })),
        second.write(fixture({ updatedAt: NOW + 20 }))
      ]);
      const raced = await Promise.all([
        second.write(fixture({ updatedAt: NOW + 40 })),
        drafts.remove("doc", "tab", NOW + 30)
      ]);
      const after = (await drafts.list("doc")).find((value) => value.ownerId === "tab");
      const removed = await drafts.remove("doc", "tab", NOW + 40);
      const missing = await drafts.remove("doc", "tab");
      await drafts.remove("doc", "other");
      const foreign = await second.list("doc-extra");
      second.close();
      return { outcomes, raced, after, removed, missing, foreign };
    });
    assert.deepEqual(result.outcomes, [true, false]);
    assert.deepEqual(result.raced, [true, false]);
    assert.equal(result.after.updatedAt, NOW + 40);
    assert.equal(result.removed, true);
    assert.equal(result.missing, false);
    assert.equal(result.foreign.length, 1);
  });

  await t.test("prunes seven-day expiry and filters invalid or unknown-schema records", async () => {
    const result = await page.evaluate(async () => {
      const db = await openRaw();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("drafts", "readwrite");
        const target = tx.objectStore("drafts");
        for (const changes of [
          { ownerId: "expired", updatedAt: NOW - 7 * DAY },
          { ownerId: "live", updatedAt: NOW - 7 * DAY + 1 },
          { documentId: "foreign", ownerId: "expired", updatedAt: NOW - 8 * DAY },
          { ownerId: "corrupt", html: 42 }, { ownerId: "future", updatedAt: NOW + 60_001 },
          { ownerId: "schema", schemaVersion: 2 }, { ownerId: "missing-schema", schemaVersion: undefined }
        ]) target.put({ schemaVersion: 1, ...fixture(changes) });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      const list = await drafts.list("doc");
      const expired = await new Promise((resolve) => {
        const request = db.transaction("drafts").objectStore("drafts").get(["foreign", "expired"]);
        request.onsuccess = () => resolve(request.result ?? null);
      });
      db.close();
      return { list, expired };
    });
    assert.deepEqual(result.list.map((value) => value.ownerId), ["live"]);
    assert.equal(result.expired, null);
  });

  await t.test("accepts exact UTF-8 limit, future tolerance and snapshots input before awaiting", async () => {
    const result = await page.evaluate(async () => {
      const exact = fixture({ documentId: "limits", html: "\u4e2d".repeat(10 * 1024 * 1024),
        title: "", updatedAt: NOW + 60_000 });
      const pending = drafts.write(exact);
      exact.html = "mutated";
      exact.ownerId = "mutated";
      await pending;
      const [saved] = await drafts.list("limits");
      await drafts.remove("limits", "tab");
      return { bytes: new TextEncoder().encode(saved.html).byteLength, owner: saved.ownerId, title: saved.title };
    });
    assert.deepEqual(result, { bytes: 30 * 1024 * 1024, owner: "tab", title: "" });
  });

  await t.test("quota failures reject without storing data and the store can recover", async () => {
    const result = await page.evaluate(async () => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException("quota", "QuotaExceededError"); };
      let message;
      try { await drafts.write(fixture({ documentId: "quota" })); }
      catch (error) { message = error.message; }
      finally { IDBObjectStore.prototype.put = original; }
      const absent = await drafts.list("quota");
      const recovered = await drafts.write(fixture({ documentId: "quota" }));
      drafts.close();
      drafts.close();
      const reopened = await drafts.list("quota");
      drafts.close();
      return { message, absent, recovered, count: reopened.length };
    });
    assert.match(result.message, /QuotaExceededError/);
    assert.deepEqual(result.absent, []);
    assert.equal(result.recovered, true);
    assert.equal(result.count, 1);
  });

  await t.test("asynchronous request failures report the native error and roll back", async () => {
    const result = await page.evaluate(async () => {
      await drafts.write(fixture({ documentId: "request-error" }));
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (record) { return this.add(record); };
      let message;
      try { await drafts.write(fixture({ documentId: "request-error", html: "replacement" })); }
      catch (error) { message = error.message; }
      finally { IDBObjectStore.prototype.put = original; }
      const [saved] = await drafts.list("request-error");
      return { message, html: saved.html };
    });
    assert.match(result.message, /ConstraintError/);
    assert.equal(result.html, "<script>window.draftExecuted = true;</script><p>Draft</p>");
  });

  await t.test("native blocked open is bounded, releases late requests, and can retry", async () => {
    const result = await page.evaluate(async () => {
      drafts.close();
      const blocker = await openRaw();
      const blocked = createDraftStore({ now: () => NOW, indexedDB: {
        // A version-2 request forces a real native blocked event against the held v1 connection.
        open: () => indexedDB.open("hwb-editor-drafts", 2)
      } });
      const start = performance.now();
      let message;
      try { await blocked.list("doc"); } catch (error) { message = error.message; }
      const elapsed = performance.now() - start;
      blocker.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase("hwb-editor-drafts");
        const timer = setTimeout(() => reject(Error("Late request leaked a connection")), 1900);
        request.onsuccess = () => { clearTimeout(timer); resolve(); };
        request.onerror = () => { clearTimeout(timer); reject(request.error); };
      });
      blocked.close();
      const retry = await drafts.write(fixture());
      drafts.close();
      return { message, elapsed, retry };
    });
    assert.match(result.message, /blocked/i);
    assert.ok(result.elapsed < 2000);
    assert.equal(result.retry, true);
  });

  await t.test("versionchange releases the connection for another tab", async () => {
    const result = await page.evaluate(async () => {
      await drafts.list("doc");
      const upgraded = await new Promise((resolve, reject) => {
        const request = indexedDB.open("hwb-editor-drafts", 2);
        request.onsuccess = () => { request.result.close(); resolve(true); };
        request.onblocked = () => reject(Error("Store failed to release its connection"));
        request.onerror = () => reject(request.error);
      });
      let message;
      try { await drafts.list("doc"); } catch (error) { message = error.message; }
      drafts.close();
      return { upgraded, message };
    });
    assert.equal(result.upgraded, true);
    assert.match(result.message, /VersionError/);
  });
});
