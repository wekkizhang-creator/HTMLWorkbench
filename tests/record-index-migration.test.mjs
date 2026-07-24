import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecordIndexDocument,
  buildRecordIndexPath
} from "../lib/record-index.mjs";

function recordAt(uploadedAt, index) {
  const id = `${String(index).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    id,
    originalName: `migration-${index}.html`,
    title: `Migration ${index}`,
    description: "",
    documentType: "Analysis",
    uploadKind: "html",
    size: index,
    uploadedAt,
    blobPath: `uploads/${id}.html`,
    recordPath: `records/${id}.json`
  };
}

async function withLocalStorage(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-migration-"));
  const previousDataDir = process.env.HTML_WORKBENCH_DATA_DIR;
  const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousVercel = process.env.VERCEL;
  process.env.HTML_WORKBENCH_DATA_DIR = dataDir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL;

  try {
    const storage = await import(`../lib/storage.mjs?migration-test=${randomUUID()}`);
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

async function writeJson(dataDir, storagePath, value) {
  const target = path.join(dataDir, ...storagePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

test("migration repairs missing, damaged, and orphaned indexes and is idempotent", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const records = [
      recordAt("2026-01-01T00:00:00.000Z", 1),
      recordAt("2026-01-02T00:00:00.000Z", 2),
      recordAt("2026-01-03T00:00:00.000Z", 3)
    ];
    await Promise.all(records.map((record) => writeJson(dataDir, record.recordPath, record)));
    await writeJson(dataDir, buildRecordIndexPath(records[0]), buildRecordIndexDocument(records[0]));
    await writeJson(dataDir, buildRecordIndexPath(records[1]), { damaged: true });
    const orphan = recordAt("2025-12-31T00:00:00.000Z", 99);
    await writeJson(dataDir, buildRecordIndexPath(orphan), buildRecordIndexDocument(orphan));

    const progress = [];
    const first = await storage.migrateRecordIndex({
      onProgress(summary) {
        progress.push(summary);
      }
    });
    assert.deepEqual(first, {
      scanned: 3,
      created: 1,
      repaired: 2,
      skipped: 1,
      failed: 0
    });
    assert.equal(progress.at(-1).scanned, 3);
    await fs.access(path.join(dataDir, "record-index-state", "v1-ready.json"));
    await assert.rejects(
      fs.access(path.join(dataDir, ...buildRecordIndexPath(orphan).split("/"))),
      (error) => error.code === "ENOENT"
    );

    const second = await storage.migrateRecordIndex();
    assert.deepEqual(second, {
      scanned: 3,
      created: 0,
      repaired: 0,
      skipped: 3,
      failed: 0
    });
  });
});

test("dry-run reports work without writing indexes or the ready marker", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const record = recordAt("2026-02-01T00:00:00.000Z", 10);
    await writeJson(dataDir, record.recordPath, record);

    assert.deepEqual(await storage.migrateRecordIndex({ dryRun: true }), {
      scanned: 1,
      created: 1,
      repaired: 0,
      skipped: 0,
      failed: 0
    });
    await assert.rejects(
      fs.access(path.join(dataDir, ...buildRecordIndexPath(record).split("/"))),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(dataDir, "record-index-state", "v1-ready.json")),
      (error) => error.code === "ENOENT"
    );
  });
});

test("package scripts expose live and dry-run record index migration", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(packageJson.scripts["migrate:record-index"], "node scripts/migrate-record-index.mjs");
  assert.equal(
    packageJson.scripts["migrate:record-index:dry-run"],
    "node scripts/migrate-record-index.mjs --dry-run"
  );
});
