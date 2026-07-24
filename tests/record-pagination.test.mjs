import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecordIndexDocument,
  buildRecordIndexPath,
  matchesRecord
} from "../lib/record-index.mjs";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function recordAt(uploadedAt, index = 0, overrides = {}) {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    originalName: `report-${index}.html`,
    title: `Report ${index}`,
    description: `Indexed record ${index}`,
    documentType: "Analysis",
    uploadKind: "html",
    size: 42,
    uploadedAt,
    blobPath: `uploads/${id}.html`,
    ...overrides
  };
}

async function withLocalStorage(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-index-"));
  const previousDataDir = process.env.HTML_WORKBENCH_DATA_DIR;
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;
  process.env.HTML_WORKBENCH_DATA_DIR = dataDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;

  try {
    const storage = await import(`../lib/storage.mjs?pagination-test=${randomUUID()}`);
    await run({ dataDir, storage });
  } finally {
    if (previousDataDir === undefined) delete process.env.HTML_WORKBENCH_DATA_DIR;
    else process.env.HTML_WORKBENCH_DATA_DIR = previousDataDir;
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    await fs.rm(dataDir, { force: true, recursive: true });
  }
}

async function seedLocalIndex(dataDir, records, { ready = true } = {}) {
  await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
  await fs.mkdir(path.join(dataDir, "record-index", "v1"), { recursive: true });
  await Promise.all(records.flatMap((record) => {
    const canonical = { ...record, recordPath: `records/${record.id}.json` };
    const index = buildRecordIndexDocument(canonical);
    return [
      fs.writeFile(
        path.join(dataDir, "records", `${record.id}.json`),
        `${JSON.stringify(canonical)}\n`,
        "utf8"
      ),
      fs.writeFile(
        path.join(dataDir, ...index.indexPath.split("/")),
        `${JSON.stringify(index)}\n`,
        "utf8"
      )
    ];
  }));
  if (ready) {
    await fs.mkdir(path.join(dataDir, "record-index-state"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "record-index-state", "v1-ready.json"),
      `${JSON.stringify({ version: 1, completedAt: "2026-07-24T00:00:00.000Z" })}\n`,
      "utf8"
    );
  }
}

async function listIndexPaths(dataDir) {
  const directory = path.join(dataDir, "record-index", "v1");
  const files = await fs.readdir(directory).catch(() => []);
  return files.sort().map((file) => `record-index/v1/${file}`);
}

test("reverse timestamp index paths sort newest first", () => {
  const older = buildRecordIndexPath({ id: ID_A, uploadedAt: "2026-01-01T00:00:00.000Z" });
  const newer = buildRecordIndexPath({ id: ID_B, uploadedAt: "2026-07-24T00:00:00.000Z" });

  assert.ok(newer.localeCompare(older) < 0);
  assert.match(newer, /^record-index\/v1\/\d{16}-[0-9a-f-]{36}\.json$/i);
});

test("index documents contain only public record fields", () => {
  const record = {
    id: ID_A,
    originalName: "report.html",
    title: "Quarterly Report",
    description: "A searchable report",
    documentType: "Analysis",
    uploadKind: "html",
    size: 42,
    uploadedAt: "2026-07-24T00:00:00.000Z",
    blobPath: "uploads/secret.html",
    blobUrl: "https://blob.example/secret",
    recordPath: `records/${ID_A}.json`
  };
  const document = buildRecordIndexDocument(record);

  assert.equal(document.indexPath, buildRecordIndexPath(record));
  assert.equal(document.recordPath, `records/${ID_A}.json`);
  assert.equal(document.record.blobPath, undefined);
  assert.equal(document.record.blobUrl, undefined);
  assert.equal(document.record.title, record.title);
});

test("record filters search public text and document type", () => {
  const record = {
    id: ID_A,
    originalName: "Quarterly-Report.html",
    title: "Revenue Overview",
    description: "A searchable report",
    documentType: "Analysis"
  };

  assert.equal(matchesRecord(record, { query: "report", documentType: "" }), true);
  assert.equal(matchesRecord(record, { query: "missing", documentType: "" }), false);
  assert.equal(matchesRecord(record, { query: "", documentType: "Analysis" }), true);
  assert.equal(matchesRecord(record, { query: "", documentType: "Prototype" }), false);
});

test("pre-epoch timestamps are rejected and epoch indexes stay 16 digits", () => {
  const epochPath = buildRecordIndexPath({ id: ID_A, uploadedAt: "1970-01-01T00:00:00.000Z" });
  const timestamp = epochPath.match(/^record-index\/v1\/(\d+)-/);
  assert.equal(timestamp?.[1].length, 16);

  assert.throws(
    () => buildRecordIndexPath({ id: ID_A, uploadedAt: "1969-12-31T23:59:59.999Z" }),
    (error) => error.status === 400 && /timestamp/i.test(error.message)
  );
});

test("1205 indexed records page without omissions or duplicates", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const records = Array.from({ length: 1205 }, (_, index) => (
      recordAt(new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), index)
    ));
    await seedLocalIndex(dataDir, records);

    const seen = new Set();
    let cursor = null;
    do {
      const result = await storage.listRecordsPage({
        limit: 50,
        cursor,
        query: "",
        documentType: ""
      });
      for (const record of result.records) {
        assert.equal(seen.has(record.id), false);
        seen.add(record.id);
      }
      cursor = result.page.nextCursor;
    } while (cursor);

    assert.equal(seen.size, 1205);
  });
});

test("sparse filtered pages consume every index without skipping later matches", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const matchingIndexes = new Set([2, 31, 74, 119, 180, 241, 299]);
    const records = Array.from({ length: 320 }, (_, index) => recordAt(
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      index,
      matchingIndexes.has(index)
        ? { title: `Needle ${index}`, documentType: "Prototype" }
        : {}
    ));
    await seedLocalIndex(dataDir, records);

    const found = [];
    let cursor = null;
    do {
      const result = await storage.listRecordsPage({
        limit: 3,
        cursor,
        query: "needle",
        documentType: "Prototype"
      });
      found.push(...result.records.map((record) => record.id));
      cursor = result.page.nextCursor;
    } while (cursor);

    assert.deepEqual(
      found.sort(),
      [...matchingIndexes].map((index) => recordAt("2026-01-01T00:00:00.000Z", index).id).sort()
    );
  });
});

test("Blob scans request only the current page's remaining match count", async () => {
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  delete process.env.VERCEL;

  const records = Array.from({ length: 5 }, (_, index) => recordAt(
    new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    index,
    index % 2 === 0 ? { title: `Needle ${index}` } : {}
  )).sort((first, second) => buildRecordIndexPath(first).localeCompare(buildRecordIndexPath(second)));
  const indexes = records.map((record) => buildRecordIndexDocument(record));
  const listLimits = [];
  const blobSdk = {
    async get(storagePath) {
      if (storagePath === "record-index-state/v1-ready.json") {
        return {
          statusCode: 200,
          stream: new Blob([JSON.stringify({ version: 1 })]).stream()
        };
      }
      const document = indexes.find((item) => item.indexPath === storagePath);
      return document
        ? { statusCode: 200, stream: new Blob([JSON.stringify(document)]).stream() }
        : null;
    },
    async list({ cursor, limit, prefix }) {
      assert.equal(prefix, "record-index/v1/");
      listLimits.push(limit);
      const start = Number(cursor || 0);
      const page = indexes.slice(start, start + limit);
      const next = start + page.length;
      return {
        blobs: page.map(({ indexPath }) => ({ pathname: indexPath })),
        cursor: next < indexes.length ? String(next) : undefined,
        hasMore: next < indexes.length
      };
    }
  };

  try {
    const storage = await import(`../lib/storage.mjs?blob-pagination-test=${randomUUID()}`);
    const first = await storage.listRecordsPage({
      blobSdk,
      limit: 2,
      cursor: null,
      query: "needle",
      documentType: ""
    });
    const second = await storage.listRecordsPage({
      blobSdk,
      limit: 2,
      cursor: first.page.nextCursor,
      query: "needle",
      documentType: ""
    });

    assert.deepEqual([...first.records, ...second.records].map((record) => record.id),
      records.filter((record) => record.title.startsWith("Needle")).map((record) => record.id));
    assert.deepEqual(listLimits, [2, 1, 2]);
  } finally {
    if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test("existing records without a completed index return a maintenance response", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    await fs.mkdir(path.join(dataDir, "records"), { recursive: true });
    const records = [
      recordAt("2026-01-01T00:00:00.000Z", 1),
      recordAt("2026-01-02T00:00:00.000Z", 2)
    ];
    await Promise.all(records.map((record) => fs.writeFile(
      path.join(dataDir, "records", `${record.id}.json`),
      JSON.stringify(record),
      "utf8"
    )));

    await assert.rejects(
      () => storage.listRecordsPage({
        limit: 50,
        cursor: null,
        query: "",
        documentType: ""
      }),
      (error) => error.status === 503 && error.code === "record_index_not_ready"
    );
  });
});

test("replace, rollback, and delete keep exactly the current timestamp index", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const original = recordAt("2026-01-01T00:00:00.000Z", 7);
    await storage.saveUpload(original.id, Buffer.from("<h1>original</h1>"));
    const savedOriginal = await storage.saveIndexedRecord(original);
    assert.deepEqual(await listIndexPaths(dataDir), [buildRecordIndexPath(savedOriginal)]);

    const previousVersion = await storage.savePreviousVersion(savedOriginal);
    await storage.saveUpload(original.id, Buffer.from("<h1>replacement</h1>"), {
      allowOverwrite: true
    });
    const replacement = {
      ...savedOriginal,
      title: "Replacement",
      uploadedAt: "2026-07-24T00:00:00.000Z",
      previousVersion
    };
    const savedReplacement = await storage.saveIndexedRecord(replacement, savedOriginal);
    assert.deepEqual(await listIndexPaths(dataDir), [buildRecordIndexPath(savedReplacement)]);

    const restored = await storage.restorePreviousVersion(savedReplacement);
    assert.deepEqual(await listIndexPaths(dataDir), [buildRecordIndexPath(restored)]);

    await storage.deleteUpload(restored);
    assert.deepEqual(await listIndexPaths(dataDir), []);
    assert.equal(await storage.getRecord(restored.id), null);
  });
});

test("upload mutation routes use indexed record writes", async () => {
  const [uploadsSource, mutationSource] = await Promise.all([
    fs.readFile(new URL("../api/uploads.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../api/delete-upload.mjs", import.meta.url), "utf8")
  ]);

  assert.match(uploadsSource, /saveIndexedRecord/);
  assert.doesNotMatch(uploadsSource, /\bsaveRecord\b/);
  assert.match(mutationSource, /saveIndexedRecord/);
  assert.doesNotMatch(mutationSource, /\bsaveRecord\b/);
});
