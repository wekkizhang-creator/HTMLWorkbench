import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRecordIndexPath } from "../lib/record-index.mjs";

const original = Buffer.from("<h1>Published source</h1>");
const edited = Buffer.from("<h1>Edited source</h1>");
const prior = Buffer.from("<h1>Existing rollback</h1>");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "editor-storage-"));
  const savedEnv = Object.fromEntries(["HTML_WORKBENCH_DATA_DIR", "BLOB_READ_WRITE_TOKEN", "VERCEL"]
    .map(key => [key, process.env[key]]));
  process.env.HTML_WORKBENCH_DATA_DIR = directory;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;
  t.after(async () => {
    t.mock.restoreAll();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const storage = await import(`../lib/storage.mjs?fixture=${encodeURIComponent(directory)}`);
  const id = "11111111-1111-4111-8111-111111111111";
  const record = {
    id, originalName: "report.html", title: "Keep title", description: "Keep description",
    documentType: "Other", size: original.length, uploadedAt: "2026-09-11T00:00:00.000Z",
    uploadKind: "html", url: `/view/${id}`, blobPath: `uploads/${id}.html`,
    recordPath: `records/${id}.json`,
    previousVersion: {
      originalName: "prior.html", title: "Prior title", description: "Prior description",
      documentType: "Other", size: prior.length, uploadedAt: "2026-09-10T00:00:00.000Z",
      uploadKind: "html", blobPath: `uploads/${id}/previous/upload.html`
    }
  };
  for (const [file, buffer] of [[record.blobPath, original], [record.previousVersion.blobPath, prior]]) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), buffer);
  }
  await storage.saveIndexedRecord(record);
  return {
    directory, record, storage,
    relative(file) { return path.relative(directory, String(file)).replaceAll("\\", "/"); },
    async assertBytesPreserved() {
      assert.deepEqual(await fs.readFile(path.join(directory, record.blobPath)), original);
      assert.deepEqual(await fs.readFile(path.join(directory, record.previousVersion.blobPath)), prior);
    },
    async assertPreserved() {
      assert.deepEqual(await storage.getRecord(id), record);
      assert.deepEqual(Buffer.from(await new Response((await storage.getUploadContent(record)).body).arrayBuffer()), original);
      await this.assertBytesPreserved();
    }
  };
}

const faults = [
  { name: "rollback staging", match: file => /\/editor\/.*\/previous.html$/.test(file) },
  { name: "content staging", match: file => /\/editor\/.*\/current.html$/.test(file) },
  { name: "content staging acknowledgment", after: true, match: file => /\/editor\/.*\/current.html$/.test(file) },
  { name: "canonical record write", match: file => file.startsWith("records/") },
  { name: "canonical record acknowledgment", after: true, match: file => file.startsWith("records/") },
  { name: "index write", match: file => file.startsWith("record-index/v1/") },
  { name: "index acknowledgment", after: true, match: file => file.startsWith("record-index/v1/") },
  { name: "stale index deletion", method: "rm", match: file => file.startsWith("record-index/v1/") && file.endsWith(".json") },
  { name: "generation update", match: file => file === "record-index-state/v1-ready.json" },
  { name: "generation acknowledgment", after: true, match: file => file === "record-index-state/v1-ready.json" }
];

for (const fault of faults) {
  test(`editor preserves both versions and metadata after ${fault.name} failure`, async t => {
    const f = await fixture(t);
    const method = fault.method || "rename";
    const operation = fs[method].bind(fs);
    let injected = false;
    t.mock.method(fs, method, async (...args) => {
      const target = method === "rename" ? args[1] : args[0];
      if (!injected && fault.match(f.relative(target))) {
        injected = true;
        if (fault.after) await operation(...args);
        throw new Error(`Injected ${fault.name} failure`);
      }
      return operation(...args);
    });
    await assert.rejects(f.storage.saveEditorReplacement(f.record, original, edited), /Injected/);
    assert.equal(injected, true);
    t.mock.restoreAll();
    await f.assertPreserved();
    if (!fault.name.includes("staging")) {
      await assert.rejects(f.storage.listRecordsPage({ limit: 10 }), { code: "record_index_not_ready" });
      const migrated = await f.storage.migrateRecordIndex();
      assert.equal(migrated.failed, 0);
      const page = await f.storage.listRecordsPage({ limit: 10 });
      assert.equal(page.records.length, 1);
      assert.equal(page.records[0].uploadedAt, f.record.uploadedAt);
      const restored = await f.storage.restorePreviousVersion(await f.storage.getRecord(f.record.id));
      assert.equal(await new Response((await f.storage.getUploadContent(restored)).body).text(), prior.toString());
    }
  });
}

test("editor retains recovery bytes and reports uncertainty when compensation also fails", async t => {
  const f = await fixture(t);
  const rename = fs.rename.bind(fs);
  let canonicalWrites = 0;
  t.mock.method(fs, "rename", async (...args) => {
    const target = f.relative(args[1]);
    if (target.startsWith("record-index/v1/")) throw new Error("Index outage");
    if (target.startsWith("records/") && ++canonicalWrites > 1) throw new Error("Restore outage");
    return rename(...args);
  });
  await assert.rejects(f.storage.saveEditorReplacement(f.record, original, edited), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /storage recovery is required/);
    assert.match(error.cause.message, /Index outage/);
    assert.match(error.restoreError.message, /Restore outage/);
    return true;
  });
  t.mock.restoreAll();
  await f.assertBytesPreserved();
  await assert.rejects(f.storage.listRecordsPage({ limit: 10 }), { code: "record_index_not_ready" });
});

test("successive editor saves stage independent rollback files and remain rollback-compatible", async t => {
  const f = await fixture(t);
  const first = await f.storage.saveEditorReplacement(f.record, original, edited);
  const secondBuffer = Buffer.from("<h1>Second edit</h1>");
  const second = await f.storage.saveEditorReplacement(first, edited, secondBuffer);
  assert.notEqual(first.blobPath, second.blobPath);
  assert.notEqual(first.previousVersion.blobPath, second.previousVersion.blobPath);
  assert.equal(second.previousVersion.title, first.title);
  assert.equal(second.previousVersion.uploadedAt, first.uploadedAt);
  assert.equal(await fs.readFile(path.join(f.directory, second.previousVersion.blobPath), "utf8"), edited.toString());
  await f.assertBytesPreserved();
  const index = JSON.parse(await fs.readFile(path.join(f.directory, buildRecordIndexPath(second)), "utf8"));
  assert.equal(index.record.uploadedAt, second.uploadedAt);
  const restored = await f.storage.restorePreviousVersion(second);
  assert.equal(await new Response((await f.storage.getUploadContent(restored)).body).text(), edited.toString());
  assert.equal(restored.previousVersion, undefined);
});
