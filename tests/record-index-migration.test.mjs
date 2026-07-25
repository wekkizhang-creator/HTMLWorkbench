import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildRecordIndexDocument,
  buildRecordIndexPath
} from "../lib/record-index.mjs";

const MAINTENANCE_LOCK_PATH = "record-index-state/v1-maintenance-lock.json";
const READY_MARKER_PATH = "record-index-state/v1-ready.json";
const READER_LEASE_PREFIX = "record-index-state/v1-leases/readers/";
const WRITER_LEASE_PREFIX = "record-index-state/v1-leases/writers/";
const execFileAsync = promisify(execFile);

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

async function waitFor(check, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function listLeaseFiles(dataDir, prefix) {
  const directory = path.join(dataDir, ...prefix.replace(/\/$/, "").split("/"));
  return fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

function activeLease(owner, ttlMs = 60_000) {
  return {
    owner,
    expiresAt: new Date(Date.now() + ttlMs).toISOString()
  };
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
    const migrationLockError = (error) => (
      error.status === 503 && error.code === "migration_lock_held"
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
        migrationLockError
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

test("two concurrent migrations allow only one owner to enter progress", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const record = recordAt("2026-04-04T00:00:00.000Z", 32);
    await writeJson(dataDir, record.recordPath, record);

    let signalProgress;
    const progressEntered = new Promise((resolve) => { signalProgress = resolve; });
    let releaseProgress;
    const progressPaused = new Promise((resolve) => { releaseProgress = resolve; });
    let firstProgressCount = 0;
    let secondProgressCount = 0;
    const first = storage.migrateRecordIndex({
      async onProgress() {
        firstProgressCount += 1;
        signalProgress();
        await progressPaused;
      }
    });

    await progressEntered;
    const secondStorage = await import(`../lib/storage.mjs?concurrent-migration-test=${randomUUID()}`);
    await assert.rejects(
      () => secondStorage.migrateRecordIndex({
        onProgress() {
          secondProgressCount += 1;
        }
      }),
      (error) => error.status === 503 && error.code === "migration_lock_held"
    );

    assert.equal(firstProgressCount, 1);
    assert.equal(secondProgressCount, 0);
    releaseProgress();
    assert.deepEqual(await first, {
      scanned: 1,
      created: 1,
      repaired: 0,
      skipped: 0,
      failed: 0
    });
  });
});

test("maintenance heartbeat cannot overwrite a replacement owner", async () => {
  await withLocalStorage(async ({ storage }) => {
    const record = recordAt("2026-04-05T00:00:00.000Z", 33);
    let sequence = 0;
    let raceArmed = false;
    let raceTriggered = false;
    const entries = new Map([
      [record.recordPath, { body: JSON.stringify(record), etag: `v${++sequence}` }]
    ]);
    const preconditionFailed = () => {
      const error = new Error("Blob precondition failed");
      error.status = 412;
      return error;
    };
    const blobSdk = {
      async put(storagePath, body, options = {}) {
        if (options.allowOverwrite === false && entries.has(storagePath)) {
          const error = new Error("Blob already exists");
          error.status = 409;
          throw error;
        }
        if (
          storagePath === MAINTENANCE_LOCK_PATH
          && options.allowOverwrite === true
          && raceArmed
          && !raceTriggered
        ) {
          entries.set(storagePath, {
            body: JSON.stringify({ owner: "replacement-owner", expiresAt: "diagnostic-only" }),
            etag: `v${++sequence}`
          });
          raceTriggered = true;
        }
        const current = entries.get(storagePath);
        if (options.ifMatch && current?.etag !== options.ifMatch) {
          throw preconditionFailed();
        }
        entries.set(storagePath, {
          body: typeof body === "string" ? body : Buffer.from(body).toString("utf8"),
          etag: `v${++sequence}`
        });
        return { pathname: storagePath, etag: `v${sequence}` };
      },
      async get(storagePath) {
        const entry = entries.get(storagePath);
        if (!entry) return null;
        return {
          statusCode: 200,
          stream: new Blob([entry.body]).stream(),
          blob: { etag: entry.etag },
          headers: new Headers({ etag: entry.etag })
        };
      },
      async del(storagePaths, options = {}) {
        const paths = Array.isArray(storagePaths) ? storagePaths : [storagePaths];
        if (options.ifMatch && entries.get(paths[0])?.etag !== options.ifMatch) {
          throw preconditionFailed();
        }
        for (const storagePath of paths) entries.delete(storagePath);
      },
      async list({ prefix }) {
        return {
          blobs: [...entries.keys()]
            .filter((storagePath) => storagePath.startsWith(prefix))
            .sort()
            .map((pathname) => ({ pathname })),
          hasMore: false
        };
      }
    };

    await assert.rejects(
      () => storage.migrateRecordIndex({
        blobSdk,
        leaseHeartbeatMs: 5,
        leaseTtlMs: 30,
        async onProgress() {
          raceArmed = true;
          await waitFor(() => raceTriggered, "maintenance heartbeat did not run");
        }
      }),
      (error) => error.status === 503 && error.code === "record_index_lease_lost"
    );
    assert.equal(JSON.parse(entries.get(MAINTENANCE_LOCK_PATH).body).owner, "replacement-owner");
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

test("migration waits for an existing writer lease and rejects new mutations without partial writes", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const original = recordAt("2026-06-01T00:00:00.000Z", 50);
    const replacement = {
      ...original,
      title: "Replacement under lease",
      uploadedAt: "2026-06-02T00:00:00.000Z"
    };
    await writeJson(dataDir, original.recordPath, original);
    await writeJson(dataDir, buildRecordIndexPath(original), buildRecordIndexDocument(original));
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2026-06-01T12:00:00.000Z"
    });

    let signalMutationStarted;
    const mutationStarted = new Promise((resolve) => { signalMutationStarted = resolve; });
    let releaseMutation;
    const mutationPaused = new Promise((resolve) => { releaseMutation = resolve; });
    assert.equal(typeof storage.withRecordMutation, "function");
    const mutation = storage.withRecordMutation(async () => {
      signalMutationStarted();
      await mutationPaused;
      return storage.saveIndexedRecord(replacement, original);
    });

    await mutationStarted;
    await waitFor(
      async () => (await listLeaseFiles(dataDir, WRITER_LEASE_PREFIX)).length === 1,
      "writer lease was not created"
    );

    let migrationProgressed = false;
    const migration = storage.migrateRecordIndex({
      leasePollIntervalMs: 5,
      leaseWaitTimeoutMs: 1000,
      onProgress() {
        migrationProgressed = true;
      }
    });
    await waitFor(
      () => fs.access(path.join(dataDir, ...MAINTENANCE_LOCK_PATH.split("/"))).then(() => true, () => false),
      "maintenance owner lease was not created"
    );

    await fs.access(path.join(dataDir, ...READY_MARKER_PATH.split("/")));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(migrationProgressed, false);

    const blocked = recordAt("2026-06-03T00:00:00.000Z", 51);
    await assert.rejects(
      () => storage.withRecordMutation(async () => {
        await storage.saveUpload(blocked.id, Buffer.from("must not be written"));
        await storage.saveIndexedRecord(blocked);
      }),
      (error) => error.status === 503 && error.code === "record_index_maintenance"
    );
    await assertMissing(dataDir, blocked.recordPath);
    await assertMissing(dataDir, `uploads/${blocked.id}.html`);

    releaseMutation();
    assert.equal((await mutation).id, original.id);
    assert.deepEqual(await migration, {
      scanned: 1,
      created: 0,
      repaired: 0,
      skipped: 1,
      failed: 0
    });
    await fs.access(path.join(dataDir, ...buildRecordIndexPath(replacement).split("/")));
    await assertMissing(dataDir, buildRecordIndexPath(original));
    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
    assert.deepEqual(await listLeaseFiles(dataDir, WRITER_LEASE_PREFIX), []);
  });
});

test("migration times out without deleting an expired operation lease", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const expiredLeasePath = `${WRITER_LEASE_PREFIX}expired-writer.json`;
    await writeJson(dataDir, expiredLeasePath, {
      owner: "expired-writer",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2026-06-04T00:00:00.000Z"
    });

    await assert.rejects(
      () => storage.migrateRecordIndex({
        leasePollIntervalMs: 5,
        leaseWaitTimeoutMs: 25
      }),
      (error) => error.status === 503 && error.code === "maintenance_wait_timeout"
    );

    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
    await fs.access(path.join(dataDir, ...expiredLeasePath.split("/")));
    await fs.access(path.join(dataDir, ...READY_MARKER_PATH.split("/")));
  });
});

test("expired maintenance lock still rejects migration without takeover", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    await writeJson(dataDir, MAINTENANCE_LOCK_PATH, {
      owner: "expired-owner",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });

    await assert.rejects(
      () => storage.migrateRecordIndex(),
      (error) => error.status === 503 && error.code === "migration_lock_held"
    );
    await fs.access(path.join(dataDir, ...MAINTENANCE_LOCK_PATH.split("/")));
  });
});

test("malformed maintenance lock fails quickly without deletion", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const lockPath = path.join(dataDir, ...MAINTENANCE_LOCK_PATH.split("/"));
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{malformed-json", "utf8");

    const startedAt = Date.now();
    await assert.rejects(
      () => storage.migrateRecordIndex(),
      (error) => error.status === 503 && error.code === "migration_lock_held"
    );
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(await fs.readFile(lockPath, "utf8"), "{malformed-json");
  });
});

test("explicit recovery removes maintenance state and a full migration rebuilds readiness", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    const record = recordAt("2026-06-05T00:00:00.000Z", 52);
    const indexPath = buildRecordIndexPath(record);
    await writeJson(dataDir, record.recordPath, record);
    await writeJson(dataDir, indexPath, buildRecordIndexDocument(record));
    await writeJson(dataDir, MAINTENANCE_LOCK_PATH, {
      owner: "stopped-admin",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    await writeJson(dataDir, `${READER_LEASE_PREFIX}orphan-reader.json`, activeLease("orphan-reader"));
    await writeJson(dataDir, `${WRITER_LEASE_PREFIX}orphan-writer.json`, activeLease("orphan-writer"));
    await writeJson(dataDir, READY_MARKER_PATH, {
      version: 1,
      completedAt: "2000-01-01T00:00:00.000Z"
    });

    assert.equal(typeof storage.recoverRecordIndexMaintenance, "function");
    const recovery = await storage.recoverRecordIndexMaintenance();
    assert.equal(recovery.requiresFullMigration, true);
    assert.match(recovery.message, /full.*migration/i);
    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
    assert.deepEqual(await listLeaseFiles(dataDir, READER_LEASE_PREFIX), []);
    assert.deepEqual(await listLeaseFiles(dataDir, WRITER_LEASE_PREFIX), []);
    await assertMissing(dataDir, READY_MARKER_PATH);
    await fs.access(path.join(dataDir, ...indexPath.split("/")));

    assert.deepEqual(await storage.migrateRecordIndex(), {
      scanned: 1,
      created: 0,
      repaired: 0,
      skipped: 1,
      failed: 0
    });
    await fs.access(path.join(dataDir, ...READY_MARKER_PATH.split("/")));
  });
});

test("migration CLI exposes explicit lock recovery", async () => {
  await withLocalStorage(async ({ dataDir }) => {
    await writeJson(dataDir, MAINTENANCE_LOCK_PATH, { owner: "stopped-admin" });
    await writeJson(dataDir, `${WRITER_LEASE_PREFIX}orphan-writer.json`, activeLease("orphan-writer"));
    await writeJson(dataDir, READY_MARKER_PATH, { version: 1 });

    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/migrate-record-index.mjs", import.meta.url)), "--recover-lock"],
      {
        env: {
          ...process.env,
          HTML_WORKBENCH_DATA_DIR: dataDir,
          BLOB_READ_WRITE_TOKEN: "",
          VERCEL: ""
        }
      }
    );

    assert.match(stdout, /full.*migration/i);
    await assertMissing(dataDir, MAINTENANCE_LOCK_PATH);
    assert.deepEqual(await listLeaseFiles(dataDir, WRITER_LEASE_PREFIX), []);
    await assertMissing(dataDir, READY_MARKER_PATH);
  });
});

test("writer lease is released when a mutation throws", async () => {
  await withLocalStorage(async ({ dataDir, storage }) => {
    await assert.rejects(
      () => storage.withRecordMutation(async () => {
        throw new Error("mutation failed");
      }),
      /mutation failed/
    );
    assert.deepEqual(await listLeaseFiles(dataDir, WRITER_LEASE_PREFIX), []);
  });
});

test("package scripts expose live, dry-run, and recovery record index commands", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(packageJson.scripts["migrate:record-index"], "node scripts/migrate-record-index.mjs");
  assert.equal(
    packageJson.scripts["migrate:record-index:dry-run"],
    "node scripts/migrate-record-index.mjs --dry-run"
  );
  assert.equal(
    packageJson.scripts["migrate:record-index:recover"],
    "node scripts/migrate-record-index.mjs --recover-lock"
  );
});
