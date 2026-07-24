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

const MAINTENANCE_LOCK_PATH = "record-index-state/v1-maintenance-lock.json";
const READY_MARKER_PATH = "record-index-state/v1-ready.json";

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

async function assertMissing(dataDir, storagePath) {
  await assert.rejects(
    fs.access(path.join(dataDir, ...storagePath.split("/"))),
    (error) => error.code === "ENOENT"
  );
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

test("failed canonical reads revoke readiness and preserve every existing index", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const record = recordAt("2026-03-01T00:00:00.000Z", 20);
    const indexPath = buildRecordIndexPath(record);
    await writeJson(dataDir, indexPath, buildRecordIndexDocument(record));
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2026-03-02T00:00:00.000Z"
    });
    const canonicalPath = path.join(dataDir, ...record.recordPath.split("/"));
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.writeFile(canonicalPath, "{broken-json", "utf8");

    assert.deepEqual(await storage.migrateRecordIndex(), {
      scanned: 1,
      created: 0,
      repaired: 0,
      skipped: 0,
      failed: 1
    });

    await fs.access(path.join(dataDir, ...indexPath.split("/")));
    await assertMissing(dataDir, READY_MARKER_PATH);
    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
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

test("maintenance lock rejects listing and every mutation lifecycle across module instances", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const record = recordAt("2026-04-01T00:00:00.000Z", 30);
    await writeJson(dataDir, record.recordPath, record);
    await writeJson(dataDir, buildRecordIndexPath(record), buildRecordIndexDocument(record));
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2026-04-02T00:00:00.000Z"
    });
    await storage.saveUpload(record.id, Buffer.from("<h1>current</h1>"));

    let signalLocked;
    const locked = new Promise((resolve) => { signalLocked = resolve; });
    let releaseProgress;
    const paused = new Promise((resolve) => { releaseProgress = resolve; });
    const migration = storage.migrateRecordIndex({
      async onProgress() {
        signalLocked();
        await paused;
      }
    });

    await locked;
    const secondStorage = await import(`../lib/storage.mjs?lock-test=${randomUUID()}`);
    const nextRecord = recordAt("2026-04-03T00:00:00.000Z", 31);
    const maintenanceError = (error) => (
      error.status === 503 && error.code === "record_index_maintenance"
    );
    const previousVersionRecord = {
      ...record,
      previousVersion: {
        originalName: record.originalName,
        title: record.title,
        description: "",
        documentType: record.documentType,
        size: record.size,
        uploadedAt: record.uploadedAt,
        uploadKind: "html",
        blobPath: `uploads/${record.id}/previous/upload.html`
      }
    };

    try {
      await fs.access(path.join(dataDir, ...MAINTENANCE_LOCK_PATH.split("/")));
      await assertMissing(dataDir, READY_MARKER_PATH);
      await assert.rejects(() => storage.listRecordsPage({
        limit: 50,
        cursor: null,
        query: "",
        documentType: ""
      }), maintenanceError);
      await assert.rejects(
        () => storage.saveIndexedRecord(nextRecord),
        maintenanceError
      );
      await assert.rejects(
        () => storage.deleteIndexedRecord(record),
        maintenanceError
      );
      await assert.rejects(
        () => storage.saveUpload(nextRecord.id, Buffer.from("blocked")),
        maintenanceError
      );
      await assert.rejects(
        () => storage.savePackageUpload(nextRecord.id, Buffer.from("blocked"), []),
        maintenanceError
      );
      await assert.rejects(
        () => storage.savePreviousVersion(record),
        maintenanceError
      );
      await assert.rejects(
        () => storage.restorePreviousVersion(previousVersionRecord),
        maintenanceError
      );
      await assert.rejects(
        () => storage.deleteCurrentUpload(record),
        maintenanceError
      );
      await assert.rejects(
        () => storage.deleteObsoleteUploadFiles(record, nextRecord),
        maintenanceError
      );
      await assert.rejects(
        () => storage.deletePreviousVersion(previousVersionRecord),
        maintenanceError
      );
      await assert.rejects(
        () => storage.deleteUpload(record),
        maintenanceError
      );
      await assert.rejects(
        () => secondStorage.migrateRecordIndex(),
        maintenanceError
      );
      await assertMissing(dataDir, READY_MARKER_PATH);
      await assertMissing(dataDir, nextRecord.recordPath);
      await assertMissing(dataDir, `uploads/${nextRecord.id}.html`);
    } finally {
      releaseProgress();
      await migration;
    }

    assert.deepEqual(await migration, {
      scanned: 1,
      created: 0,
      repaired: 0,
      skipped: 1,
      failed: 0
    });
    await fs.access(path.join(dataDir, ...READY_MARKER_PATH.split("/")));
    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
  });
});

test("orphan cleanup rechecks a concurrently created canonical before deleting its current index", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const existing = recordAt("2026-05-01T00:00:00.000Z", 40);
    const concurrent = recordAt("2026-05-02T00:00:00.000Z", 41);
    await writeJson(dataDir, existing.recordPath, existing);
    await writeJson(dataDir, buildRecordIndexPath(existing), buildRecordIndexDocument(existing));
    await writeJson(dataDir, buildRecordIndexPath(concurrent), buildRecordIndexDocument(concurrent));
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2026-05-03T00:00:00.000Z"
    });

    let signalScanned;
    const scanned = new Promise((resolve) => { signalScanned = resolve; });
    let releaseProgress;
    const paused = new Promise((resolve) => { releaseProgress = resolve; });
    const migration = storage.migrateRecordIndex({
      async onProgress() {
        signalScanned();
        await paused;
      }
    });

    await scanned;
    await writeJson(dataDir, concurrent.recordPath, concurrent);
    releaseProgress();

    assert.deepEqual(await migration, {
      scanned: 1,
      created: 0,
      repaired: 0,
      skipped: 1,
      failed: 0
    });
    await fs.access(path.join(dataDir, ...buildRecordIndexPath(concurrent).split("/")));
    const page = await storage.listRecordsPage({
      limit: 50,
      cursor: null,
      query: "",
      documentType: ""
    });
    assert.deepEqual(
      page.records.map((record) => record.id).sort(),
      [existing.id, concurrent.id].sort()
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
