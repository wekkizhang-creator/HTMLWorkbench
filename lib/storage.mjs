import fs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import {
  getPackageSourcePath,
  getPreviousPackageSourcePath,
  getPreviousSiteFilePath,
  getPreviousUploadPath,
  getRecordPath,
  getSiteFilePath,
  getUploadPath,
  RECORD_INDEX_DIRTY_PATH,
  RECORD_INDEX_MAINTENANCE_LOCK_PATH,
  RECORD_INDEX_PREFIX,
  RECORD_INDEX_READER_LEASE_PREFIX,
  RECORD_INDEX_READY_PATH,
  RECORD_INDEX_WRITER_LEASE_PREFIX,
  RECORD_PREFIX
} from "./constants.mjs";
import {
  decodePageCursor,
  encodePageCursor
} from "./cursor.mjs";
import {
  buildRecordIndexDocument,
  buildRecordIndexPath,
  matchesRecord
} from "./record-index.mjs";

const DATA_DIR = process.env.HTML_WORKBENCH_DATA_DIR
  ? path.resolve(process.env.HTML_WORKBENCH_DATA_DIR)
  : path.join(process.cwd(), "data");
const RECORD_DIR = path.join(DATA_DIR, "records");

function isVercelProduction() {
  return process.env.VERCEL === "1";
}

function hasBlobToken() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function shouldUseBlobStore() {
  return hasBlobToken();
}

function assertStorageConfigured() {
  if (isVercelProduction() && !hasBlobToken()) {
    const configError = new Error("Vercel deployment requires Vercel Blob and BLOB_READ_WRITE_TOKEN");
    configError.status = 500;
    throw configError;
  }
}

async function getBlobSdk() {
  assertStorageConfigured();
  return import("@vercel/blob");
}

async function streamToText(stream) {
  return new Response(stream).text();
}

async function streamToBuffer(stream) {
  const arrayBuffer = await new Response(stream).arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function bodyToBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  return streamToBuffer(body);
}

function isMissingBlobError(error) {
  return error?.name === "BlobNotFoundError" || error?.status === 404 || /not found/i.test(error?.message || "");
}

async function ensureLocalStore() {
  await fs.mkdir(RECORD_DIR, { recursive: true });
}

export async function retryBusyLocalOperation(operation, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        const busyError = new Error("File is currently in use; please retry");
        busyError.status = 409;
        busyError.cause = error;
        throw busyError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function writeLocalFileAtomically(localPath, body) {
  const temporaryPath = `${localPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, body);
    await retryBusyLocalOperation(() => fs.rename(temporaryPath, localPath));
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function checkBlobReadiness(probe, timeoutMs = 3000) {
  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(probe),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Blob readiness check timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkStorageReadiness() {
  assertStorageConfigured();
  if (shouldUseBlobStore()) {
    const { list } = await getBlobSdk();
    await checkBlobReadiness(() => list({ prefix: RECORD_PREFIX, limit: 1 }));
    return;
  }

  await ensureLocalStore();
  const accessMode = fsConstants.R_OK | fsConstants.W_OK;
  await Promise.all([
    fs.access(DATA_DIR, accessMode),
    fs.access(RECORD_DIR, accessMode)
  ]);
}

function resolveLocalStoragePath(storagePath) {
  const normalized = String(storagePath || "").replaceAll("\\", "/");
  const resolved = path.resolve(DATA_DIR, normalized);
  const relative = path.relative(DATA_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const pathError = new Error("Storage path is invalid");
    pathError.status = 400;
    throw pathError;
  }
  return resolved;
}

async function putStoredFile(storagePath, body, options = {}) {
  assertStorageConfigured();
  const contentType = options.contentType || "application/octet-stream";
  const allowOverwrite = Boolean(options.allowOverwrite);

  if (shouldUseBlobStore()) {
    const { put } = await getBlobSdk();
    return put(storagePath, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite,
      cacheControlMaxAge: 60,
      contentType
    });
  }

  await ensureLocalStore();
  const localPath = resolveLocalStoragePath(storagePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await writeLocalFileAtomically(localPath, body);
  return {
    pathname: storagePath,
    url: storagePath,
    downloadUrl: storagePath
  };
}

async function getStoredFile(storagePath) {
  assertStorageConfigured();
  if (!storagePath) {
    return null;
  }

  if (shouldUseBlobStore()) {
    const { get } = await getBlobSdk();
    try {
      const result = await get(storagePath, { access: "private" });
      if (!result || result.statusCode !== 200) {
        return null;
      }
      return {
        body: result.stream,
        contentLength: result.blob?.size
      };
    } catch (error) {
      if (isMissingBlobError(error)) {
        return null;
      }
      throw error;
    }
  }

  await ensureLocalStore();
  let fileHandle;
  try {
    const localPath = resolveLocalStoragePath(storagePath);
    fileHandle = await fs.open(localPath, "r");
    const stats = await fileHandle.stat();
    const nodeStream = fileHandle.createReadStream({ autoClose: true });
    const body = Readable.toWeb(nodeStream);
    fileHandle = null;
    return {
      body,
      contentLength: stats.size
    };
  } catch (error) {
    await fileHandle?.close().catch(() => {});
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

}

async function deleteStoredFiles(storagePaths) {
  assertStorageConfigured();
  const paths = Array.from(new Set(storagePaths.filter(Boolean)));
  if (!paths.length) {
    return;
  }

  if (shouldUseBlobStore()) {
    const { del } = await getBlobSdk();
    await del(paths);
    return;
  }

  await ensureLocalStore();
  await Promise.all(paths.map(async (storagePath) => {
    const localPath = resolveLocalStoragePath(storagePath);
    await retryBusyLocalOperation(() => fs.rm(localPath, { force: true }));
  }));
}

function usesBlobStore(options = {}) {
  return Boolean(options.blobSdk) || shouldUseBlobStore();
}

async function resolveBlobSdk(options = {}) {
  return options.blobSdk || getBlobSdk();
}

async function putStoredJson(storagePath, value, options = {}) {
  const body = JSON.stringify(value, null, 2);
  if (usesBlobStore(options)) {
    const { put } = await resolveBlobSdk(options);
    await put(storagePath, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8"
    });
    return;
  }

  await ensureLocalStore();
  const localPath = resolveLocalStoragePath(storagePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await writeLocalFileAtomically(localPath, `${body}\n`);
}

async function getStoredJson(storagePath, options = {}) {
  if (usesBlobStore(options)) {
    const { get } = await resolveBlobSdk(options);
    try {
      const result = await get(storagePath, { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) {
        return null;
      }
      return JSON.parse(await streamToText(result.stream));
    } catch (error) {
      if (isMissingBlobError(error)) {
        return null;
      }
      throw error;
    }
  }

  await ensureLocalStore();
  try {
    return JSON.parse(await fs.readFile(resolveLocalStoragePath(storagePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getBlobJsonSnapshot(storagePath, options = {}) {
  const { get } = await resolveBlobSdk(options);
  try {
    const result = await get(storagePath, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    return {
      etag: result.blob?.etag || result.headers?.get?.("etag") || null,
      value: JSON.parse(await streamToText(result.stream))
    };
  } catch (error) {
    if (isMissingBlobError(error)) return null;
    throw error;
  }
}

function recordIndexMaintenance() {
  const error = new Error("Upload records are temporarily unavailable during index maintenance");
  error.status = 503;
  error.code = "record_index_maintenance";
  return error;
}

function maintenanceWaitTimeout() {
  const error = new Error("Timed out waiting for active upload operations to finish");
  error.status = 503;
  error.code = "maintenance_wait_timeout";
  return error;
}

function migrationLockHeld() {
  const error = new Error("Record index migration lock is already held; explicit recovery is required for abandoned locks");
  error.status = 503;
  error.code = "migration_lock_held";
  return error;
}

function recordIndexLeaseLost() {
  const error = new Error("Upload operation lease was lost");
  error.status = 503;
  error.code = "record_index_lease_lost";
  return error;
}

function isAlreadyExistingLock(error) {
  return error?.code === "EEXIST"
    || error?.status === 409
    || /already exists|overwrite/i.test(error?.message || "");
}

function isPreconditionFailed(error) {
  return error?.status === 412
    || error?.name === "BlobPreconditionFailedError"
    || /precondition/i.test(error?.message || "");
}

function positiveMilliseconds(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolveLeaseTiming(options = {}) {
  const ttlMs = positiveMilliseconds(
    options.leaseTtlMs ?? process.env.HTML_WORKBENCH_LEASE_TTL_MS,
    30_000,
    30
  );
  return {
    ttlMs,
    heartbeatMs: positiveMilliseconds(
      options.leaseHeartbeatMs ?? process.env.HTML_WORKBENCH_LEASE_HEARTBEAT_MS,
      Math.max(10, Math.floor(ttlMs / 3)),
      5
    )
  };
}

function leaseExpiresAt(ttlMs) {
  return new Date(Date.now() + ttlMs).toISOString();
}

async function createStoredJsonExclusive(storagePath, value, options = {}) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (usesBlobStore(options)) {
    const { put } = await resolveBlobSdk(options);
    try {
      await put(storagePath, body, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        contentType: "application/json; charset=utf-8"
      });
      return true;
    } catch (error) {
      if (isAlreadyExistingLock(error)) return false;
      throw error;
    }
  }

  await ensureLocalStore();
  const localPath = resolveLocalStoragePath(storagePath);
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  let handle;
  try {
    handle = await fs.open(localPath, "wx");
    await handle.writeFile(body, "utf8");
    return true;
  } catch (error) {
    if (isAlreadyExistingLock(error)) return false;
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
      await fs.rm(localPath, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function createLocalMaintenanceLease(lease) {
  await ensureLocalStore();
  const lockPath = resolveLocalStoragePath(RECORD_INDEX_MAINTENANCE_LOCK_PATH);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }

  lease.lockPath = RECORD_INDEX_MAINTENANCE_LOCK_PATH;
  lease.path = `${RECORD_INDEX_MAINTENANCE_LOCK_PATH}/${lease.owner}.json`;
  await fs.writeFile(
    resolveLocalStoragePath(lease.path),
    `${JSON.stringify(lease, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  return true;
}

async function deleteOwnedLease(lease, options = {}) {
  if (lease.lockPath && !usesBlobStore(options)) {
    let current;
    try {
      current = await getStoredJson(lease.path, options);
    } catch {
      return false;
    }
    if (current?.owner !== lease.owner) return false;
    await fs.rm(resolveLocalStoragePath(lease.path), { force: true });
    try {
      await fs.rmdir(resolveLocalStoragePath(lease.lockPath));
      return true;
    } catch (error) {
      if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) return false;
      throw error;
    }
  }

  if (usesBlobStore(options)) {
    let snapshot;
    try {
      snapshot = await getBlobJsonSnapshot(lease.path, options);
    } catch {
      return false;
    }
    if (snapshot?.value?.owner !== lease.owner || !snapshot.etag) return false;
    const { del } = await resolveBlobSdk(options);
    try {
      await del(lease.path, { ifMatch: snapshot.etag });
      return true;
    } catch (error) {
      if (isPreconditionFailed(error) || isMissingBlobError(error)) return false;
      throw error;
    }
  }

  let current;
  try {
    current = await getStoredJson(lease.path, options);
  } catch {
    return false;
  }
  if (current?.owner !== lease.owner) return false;
  await deleteStoragePaths([lease.path], options);
  return true;
}

async function readActiveMaintenance(options = {}) {
  try {
    return await getStoredJson(RECORD_INDEX_MAINTENANCE_LOCK_PATH, options);
  } catch {
    throw recordIndexMaintenance();
  }
}

const writerLeaseContext = new AsyncLocalStorage();

async function renewOwnedLease(lease, timing, options = {}) {
  const expiresAt = leaseExpiresAt(timing.ttlMs);
  if (usesBlobStore(options)) {
    let snapshot;
    try {
      snapshot = await getBlobJsonSnapshot(lease.path, options);
    } catch (error) {
      if (error instanceof SyntaxError) throw recordIndexLeaseLost();
      throw error;
    }
    if (snapshot?.value?.owner !== lease.owner || !snapshot.etag) {
      throw recordIndexLeaseLost();
    }
    const { put } = await resolveBlobSdk(options);
    try {
      await put(lease.path, JSON.stringify({
        ...snapshot.value,
        expiresAt
      }, null, 2), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60,
        contentType: "application/json; charset=utf-8",
        ifMatch: snapshot.etag
      });
    } catch (error) {
      if (isPreconditionFailed(error)) throw recordIndexLeaseLost();
      throw error;
    }
    lease.expiresAt = expiresAt;
    return;
  }

  await ensureLocalStore();
  const localPath = resolveLocalStoragePath(lease.path);
  let handle;
  try {
    handle = await fs.open(localPath, "r+");
    const openedStat = await handle.stat();
    const current = JSON.parse(await handle.readFile("utf8"));
    if (current?.owner !== lease.owner) throw recordIndexLeaseLost();
    const pathStat = await fs.stat(localPath);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw recordIndexLeaseLost();
    }
    const body = `${JSON.stringify({ ...current, expiresAt }, null, 2)}\n`;
    await handle.write(body, 0, "utf8");
    await handle.truncate(Buffer.byteLength(body));
    await handle.sync();
    const finalPathStat = await fs.stat(localPath);
    if (openedStat.dev !== finalPathStat.dev || openedStat.ino !== finalPathStat.ino) {
      throw recordIndexLeaseLost();
    }
    lease.expiresAt = expiresAt;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      throw recordIndexLeaseLost();
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function assertRecordIndexAvailable(options = {}) {
  assertStorageConfigured();
  if (writerLeaseContext.getStore()) return;
  if (await readActiveMaintenance(options)) {
    throw recordIndexMaintenance();
  }
}

function startLeaseHeartbeat(lease, timing, options = {}) {
  let heartbeatError;
  let pending = Promise.resolve();
  const renew = () => renewOwnedLease(lease, timing, options);
  const timer = setInterval(() => {
    pending = pending.then(renew).catch((error) => {
      heartbeatError ||= error;
    });
  }, timing.heartbeatMs);
  timer.unref?.();
  return {
    assertHealthy() {
      if (heartbeatError) throw heartbeatError;
    },
    async stop() {
      clearInterval(timer);
      await pending;
    }
  };
}

async function acquireOrdinaryLease(kind, options = {}) {
  await assertRecordIndexAvailable(options);
  const timing = resolveLeaseTiming(options);
  const owner = randomUUID();
  const prefix = kind === "reader"
    ? RECORD_INDEX_READER_LEASE_PREFIX
    : RECORD_INDEX_WRITER_LEASE_PREFIX;
  const lease = {
    version: 1,
    owner,
    kind,
    expiresAt: leaseExpiresAt(timing.ttlMs),
    path: `${prefix}${owner}.json`
  };
  const created = await createStoredJsonExclusive(lease.path, lease, options);
  if (!created) throw recordIndexLeaseLost();

  try {
    if (await readActiveMaintenance(options)) {
      throw recordIndexMaintenance();
    }
  } catch (error) {
    await deleteOwnedLease(lease, options);
    throw error;
  }
  return { lease, timing };
}

async function withOrdinaryLease(kind, operation, options = {}) {
  const { lease, timing } = await acquireOrdinaryLease(kind, options);
  const heartbeat = startLeaseHeartbeat(lease, timing, options);
  try {
    const result = kind === "writer"
      ? await writerLeaseContext.run(lease, operation)
      : await operation();
    heartbeat.assertHealthy();
    return result;
  } finally {
    await heartbeat.stop();
    await deleteOwnedLease(lease, options);
  }
}

export async function withRecordMutation(operation) {
  if (typeof operation !== "function") throw new TypeError("Record mutation must be a function");
  if (writerLeaseContext.getStore()) return operation();
  return withOrdinaryLease("writer", operation);
}

async function withRecordReader(operation, options = {}) {
  return withOrdinaryLease("reader", operation, options);
}

async function acquireRecordIndexMaintenanceLock(options = {}) {
  const timing = resolveLeaseTiming(options);
  const lease = {
    version: 1,
    owner: randomUUID(),
    kind: "maintenance",
    startedAt: new Date().toISOString(),
    expiresAt: leaseExpiresAt(timing.ttlMs),
    path: RECORD_INDEX_MAINTENANCE_LOCK_PATH
  };
  const created = usesBlobStore(options)
    ? await createStoredJsonExclusive(lease.path, lease, options)
    : await createLocalMaintenanceLease(lease);
  if (!created) {
    throw migrationLockHeld();
  }
  return {
    heartbeat: startLeaseHeartbeat(lease, timing, options),
    lease
  };
}

async function listActiveOrdinaryLeases(options = {}) {
  const active = [];
  for (const prefix of [RECORD_INDEX_READER_LEASE_PREFIX, RECORD_INDEX_WRITER_LEASE_PREFIX]) {
    active.push(...await listAllStoragePaths(prefix, options));
  }
  return active;
}

async function waitForOrdinaryLeases(options = {}) {
  const timeoutMs = positiveMilliseconds(options.leaseWaitTimeoutMs, 30_000);
  const pollMs = positiveMilliseconds(options.leasePollIntervalMs, 25);
  const deadline = Date.now() + timeoutMs;
  while ((await listActiveOrdinaryLeases(options)).length > 0) {
    if (Date.now() >= deadline) throw maintenanceWaitTimeout();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function deleteStoragePaths(storagePaths, options = {}) {
  const paths = Array.from(new Set(storagePaths.filter(Boolean)));
  if (!paths.length) {
    return;
  }
  if (usesBlobStore(options)) {
    const { del } = await resolveBlobSdk(options);
    await del(paths);
    return;
  }
  await deleteStoredFiles(paths);
}

async function listAllStoragePaths(prefix, options = {}) {
  if (usesBlobStore(options)) {
    const { list } = await resolveBlobSdk(options);
    const paths = [];
    let cursor;
    do {
      const result = await list({ prefix, limit: 1000, cursor });
      paths.push(...result.blobs.map((blob) => blob.pathname));
      if (result.hasMore && !result.cursor) {
        throw new Error(`Blob listing for ${prefix} did not return a continuation cursor`);
      }
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return paths;
  }

  await ensureLocalStore();
  const directory = resolveLocalStoragePath(prefix.replace(/\/$/, ""));
  const files = await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => `${prefix}${file}`);
}

async function deleteMaintenanceLockForRecovery(options = {}) {
  if (usesBlobStore(options)) {
    await deleteStoragePaths([RECORD_INDEX_MAINTENANCE_LOCK_PATH], options);
    return;
  }
  await fs.rm(resolveLocalStoragePath(RECORD_INDEX_MAINTENANCE_LOCK_PATH), {
    force: true,
    recursive: true
  });
}

export async function recoverRecordIndexMaintenance({ blobSdk } = {}) {
  assertStorageConfigured();
  const storageOptions = blobSdk ? { blobSdk } : {};
  const [statePaths, readerLeases, writerLeases] = await Promise.all([
    listAllStoragePaths("record-index-state/", storageOptions),
    listAllStoragePaths(RECORD_INDEX_READER_LEASE_PREFIX, storageOptions),
    listAllStoragePaths(RECORD_INDEX_WRITER_LEASE_PREFIX, storageOptions)
  ]);
  const hadMaintenanceLock = statePaths.includes(RECORD_INDEX_MAINTENANCE_LOCK_PATH);
  const hadReadyMarker = statePaths.includes(RECORD_INDEX_READY_PATH);

  await deleteStoragePaths([RECORD_INDEX_READY_PATH], storageOptions);
  await deleteStoragePaths([...readerLeases, ...writerLeases], storageOptions);
  await deleteMaintenanceLockForRecovery(storageOptions);

  return {
    maintenanceLockRemoved: hadMaintenanceLock,
    readerLeasesRemoved: readerLeases.length,
    writerLeasesRemoved: writerLeases.length,
    readyMarkerRemoved: hadReadyMarker,
    requiresFullMigration: true,
    message: "Use recovery only after confirming all admin processes are stopped. A full record-index migration must be run; recovery cannot restore the ready marker."
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function normalizeSitePath(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    return "index.html";
  }
  if (parts.some((part) => part === "." || part === ".." || part.includes(":"))) {
    const pathError = new Error("Asset path is invalid");
    pathError.status = 403;
    throw pathError;
  }
  return parts.join("/");
}

function currentUploadKind(record) {
  return record?.uploadKind === "zip" ? "zip" : "html";
}

function currentSiteFiles(record) {
  return Array.isArray(record?.siteFiles) ? record.siteFiles : [];
}

function currentUploadPaths(record) {
  if (currentUploadKind(record) === "zip") {
    return [
      record.sourceBlobPath || getPackageSourcePath(record.id),
      ...currentSiteFiles(record).map((file) => file.blobPath)
    ].filter(Boolean);
  }
  return [record.blobPath || getUploadPath(record.id)].filter(Boolean);
}

export async function saveUpload(id, fileBuffer, options = {}) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => saveUpload(id, fileBuffer, options));
  }
  await assertRecordIndexAvailable();
  return putStoredFile(getUploadPath(id), fileBuffer, {
    allowOverwrite: options.allowOverwrite,
    contentType: "text/html; charset=utf-8"
  });
}

export async function savePackageUpload(id, packageBuffer, files, options = {}) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => savePackageUpload(id, packageBuffer, files, options));
  }
  await assertRecordIndexAvailable();
  const packageBlob = await putStoredFile(getPackageSourcePath(id), packageBuffer, {
    allowOverwrite: options.allowOverwrite,
    contentType: "application/zip"
  });
  const siteFiles = [];
  for (const file of files) {
    const pathname = normalizeSitePath(file.pathname);
    const stored = await putStoredFile(getSiteFilePath(id, pathname), file.buffer, {
      allowOverwrite: options.allowOverwrite,
      contentType: file.contentType || "application/octet-stream"
    });
    siteFiles.push({
      pathname,
      blobPath: stored.pathname,
      contentType: file.contentType || "application/octet-stream",
      size: file.size ?? file.buffer.length
    });
  }
  return {
    packageBlob,
    siteFiles
  };
}

export async function saveRecord(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => saveRecord(record));
  }
  assertStorageConfigured();
  await assertRecordIndexAvailable();
  const recordPath = getRecordPath(record.id);
  const normalizedRecord = {
    ...record,
    recordPath
  };
  await putStoredJson(recordPath, normalizedRecord);
  return normalizedRecord;
}

function normalizeListFilters(options = {}) {
  return {
    query: String(options.query || "").trim().toLowerCase().slice(0, 120),
    documentType: String(options.documentType || "").trim()
  };
}

function recordIndexNotReady() {
  const error = new Error("Upload records are temporarily unavailable while the index is rebuilt");
  error.status = 503;
  error.code = "record_index_not_ready";
  return error;
}

async function hasCanonicalRecords(options = {}) {
  if (usesBlobStore(options)) {
    const { list } = await resolveBlobSdk(options);
    const result = await list({ prefix: RECORD_PREFIX, limit: 1 });
    return result.blobs.some((blob) => blob.pathname.endsWith(".json"));
  }
  await ensureLocalStore();
  const files = await fs.readdir(RECORD_DIR).catch(() => []);
  return files.some((file) => file.endsWith(".json"));
}

async function hasRecordIndexReadyMarker(options = {}) {
  return Boolean(await getStoredJson(RECORD_INDEX_READY_PATH, options));
}

async function hasRecordIndexDirtyMarker(options = {}) {
  return Boolean(await getStoredJson(RECORD_INDEX_DIRTY_PATH, options));
}

async function assertRecordIndexReady(options = {}) {
  if (await hasRecordIndexDirtyMarker(options)) throw recordIndexNotReady();
  if (await hasRecordIndexReadyMarker(options)) {
    return;
  }
  if (await hasCanonicalRecords(options)) {
    throw recordIndexNotReady();
  }
}

export async function writeRecordIndexReadyMarker(marker = {}, options = {}) {
  await putStoredJson(RECORD_INDEX_READY_PATH, {
    version: 1,
    completedAt: new Date().toISOString(),
    ...marker
  }, options);
}

async function recordIndexIsComplete(options = {}) {
  const recordPaths = await listAllStoragePaths(RECORD_PREFIX, options);
  const expectedPaths = new Set();
  for (const recordPath of recordPaths) {
    let record;
    let actualIndex;
    try {
      record = await getStoredJson(recordPath, options);
      if (!record || typeof record.id !== "string") return false;
      const expectedIndex = buildRecordIndexDocument(record);
      if (expectedPaths.has(expectedIndex.indexPath)) return false;
      expectedPaths.add(expectedIndex.indexPath);
      actualIndex = await getStoredJson(expectedIndex.indexPath, options);
      if (!indexDocumentsEqual(actualIndex, expectedIndex)) return false;
    } catch (error) {
      if (error instanceof SyntaxError || error?.code === "invalid_record_timestamp") return false;
      throw error;
    }
  }
  const indexPaths = await listAllStoragePaths(RECORD_INDEX_PREFIX, options);
  return indexPaths.length === expectedPaths.size
    && indexPaths.every((indexPath) => expectedPaths.has(indexPath));
}

async function revokeReadyAfterMutationFailure(originalError, options = {}) {
  try {
    await putStoredJson(RECORD_INDEX_DIRTY_PATH, {
      version: 1,
      failedAt: new Date().toISOString()
    }, options);
  } catch (dirtyMarkerError) {
    try {
      originalError.dirtyMarkerError = dirtyMarkerError;
    } catch {
      // Preserve the mutation error even when an immutable error object cannot be annotated.
    }
  }
  try {
    await deleteStoragePaths([RECORD_INDEX_READY_PATH], options);
  } catch (readinessError) {
    try {
      originalError.readinessRevocationError = readinessError;
    } catch {
      // Preserve the mutation error even when an immutable error object cannot be annotated.
    }
  }
}

async function bootstrapRecordIndexReady(options = {}) {
  if (await hasRecordIndexDirtyMarker(options)) return;
  if (!await recordIndexIsComplete(options)) return;
  await writeRecordIndexReadyMarker({}, options);
  if (await hasRecordIndexDirtyMarker(options) || !await recordIndexIsComplete(options)) {
    await deleteStoragePaths([RECORD_INDEX_READY_PATH], options);
  }
}

export async function saveIndexedRecord(record, previousRecord) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => saveIndexedRecord(record, previousRecord));
  }
  assertStorageConfigured();
  await assertRecordIndexAvailable();
  const initializeReadyMarker = !(await hasRecordIndexReadyMarker())
    && !(await hasCanonicalRecords());
  let consistencyMayHaveChanged = false;
  try {
    consistencyMayHaveChanged = true;
    const savedRecord = await saveRecord(record);
    const indexDocument = buildRecordIndexDocument(savedRecord);
    await putStoredJson(indexDocument.indexPath, indexDocument);

    if (previousRecord) {
      const previousIndexPath = buildRecordIndexPath(previousRecord);
      if (previousIndexPath !== indexDocument.indexPath) {
        await deleteStoredFiles([previousIndexPath]);
      }
    }
    if (initializeReadyMarker) {
      await bootstrapRecordIndexReady();
    }
    return savedRecord;
  } catch (error) {
    if (consistencyMayHaveChanged) {
      await revokeReadyAfterMutationFailure(error);
    }
    throw error;
  }
}

export async function deleteIndexedRecord(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => deleteIndexedRecord(record));
  }
  await assertRecordIndexAvailable();
  try {
    await deleteStoredFiles([
      record.recordPath || getRecordPath(record.id),
      buildRecordIndexPath(record)
    ]);
  } catch (error) {
    await revokeReadyAfterMutationFailure(error);
    throw error;
  }
}

async function listLocalRecordsPage({ limit, storageCursor, filters }) {
  const indexPaths = await listAllStoragePaths(RECORD_INDEX_PREFIX);
  const cursorIndex = storageCursor === null
    ? 0
    : indexPaths.findIndex((indexPath) => path.basename(indexPath) > storageCursor);
  let position = cursorIndex === -1 ? indexPaths.length : cursorIndex;
  const records = [];
  let lastConsumed = storageCursor;

  while (position < indexPaths.length && records.length < limit) {
    const indexPath = indexPaths[position++];
    lastConsumed = path.basename(indexPath);
    const document = await getStoredJson(indexPath);
    if (document?.record && matchesRecord(document.record, filters)) {
      records.push(document.record);
    }
  }

  return {
    records,
    hasMore: position < indexPaths.length,
    storageCursor: lastConsumed
  };
}

async function listBlobRecordsPage({ blobSdk, limit, storageCursor, filters }) {
  const { get, list } = await resolveBlobSdk({ blobSdk });
  const records = [];
  let hasMore = true;
  let nextStorageCursor = storageCursor;

  while (records.length < limit && hasMore) {
    const scanLimit = limit - records.length;
    const result = await list({
      prefix: RECORD_INDEX_PREFIX,
      limit: scanLimit,
      cursor: nextStorageCursor || undefined
    });
    const documents = await mapWithConcurrency(result.blobs, 12, async (blob) => {
      try {
        const stored = await get(blob.pathname, { access: "private", useCache: false });
        if (!stored || stored.statusCode !== 200) return null;
        return JSON.parse(await streamToText(stored.stream));
      } catch (error) {
        if (isMissingBlobError(error)) return null;
        throw error;
      }
    });

    for (const document of documents) {
      if (document?.record && matchesRecord(document.record, filters)) {
        records.push(document.record);
      }
    }

    hasMore = Boolean(result.hasMore);
    if (hasMore && !result.cursor) {
      throw new Error("Blob index listing did not return a continuation cursor");
    }
    if (hasMore && result.blobs.length === 0) {
      throw new Error("Blob index listing did not advance");
    }
    nextStorageCursor = hasMore ? result.cursor : null;
  }

  return { records, hasMore, storageCursor: nextStorageCursor };
}

export async function listRecordsPage(options = {}) {
  assertStorageConfigured();
  const storageOptions = options.blobSdk ? { blobSdk: options.blobSdk } : {};
  return withRecordReader(
    () => listRecordsPageWithinLease(options, storageOptions),
    storageOptions
  );
}

async function listRecordsPageWithinLease(options, storageOptions) {
  const limit = Number(options.limit);
  const filters = normalizeListFilters(options);
  const cursorState = options.cursor
    ? decodePageCursor(options.cursor, filters)
    : { storageCursor: null };
  await assertRecordIndexReady(storageOptions);

  const result = usesBlobStore(storageOptions)
    ? await listBlobRecordsPage({
        blobSdk: options.blobSdk,
        limit,
        storageCursor: cursorState.storageCursor,
        filters
      })
    : await listLocalRecordsPage({
        limit,
        storageCursor: cursorState.storageCursor,
        filters
      });

  return {
    records: result.records,
    page: {
      limit,
      hasMore: result.hasMore,
      nextCursor: result.hasMore
        ? encodePageCursor({
            version: 1,
            storageCursor: result.storageCursor,
            query: filters.query,
            documentType: filters.documentType
          })
        : null
    }
  };
}

export async function listRecords() {
  assertStorageConfigured();

  if (shouldUseBlobStore()) {
    const { get, list } = await getBlobSdk();
    const { blobs } = await list({ prefix: RECORD_PREFIX, limit: 1000 });
    const records = await Promise.all(
      blobs
        .filter((blob) => blob.pathname.endsWith(".json"))
        .map(async (blob) => {
          const result = await get(blob.pathname, { access: "private", useCache: false });
          if (!result || result.statusCode !== 200) {
            return null;
          }
          return JSON.parse(await streamToText(result.stream));
        })
    );
    return records.filter(Boolean).sort(sortNewestFirst);
  }

  await ensureLocalStore();
  const files = await fs.readdir(RECORD_DIR).catch(() => []);
  const records = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const raw = await fs.readFile(path.join(RECORD_DIR, file), "utf8");
        return JSON.parse(raw);
      })
  );
  return records.sort(sortNewestFirst);
}

function indexDocumentsEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function ensureRecordIndex(record, { dryRun, summary, storageOptions }) {
  const expected = buildRecordIndexDocument(record);
  let existing;
  let damaged = false;
  try {
    existing = await getStoredJson(expected.indexPath, storageOptions);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    damaged = true;
  }

  if (existing && indexDocumentsEqual(existing, expected)) {
    summary.skipped += 1;
    return expected.indexPath;
  }
  if (!dryRun) {
    await putStoredJson(expected.indexPath, expected, storageOptions);
  }
  if (damaged || existing) {
    summary.repaired += 1;
  } else {
    summary.created += 1;
  }
  return expected.indexPath;
}

async function removeOrphanIndexes(expectedPaths, { dryRun, summary, storageOptions }) {
  const indexPaths = await listAllStoragePaths(RECORD_INDEX_PREFIX, storageOptions);
  for (const indexPath of indexPaths) {
    if (expectedPaths.has(indexPath)) {
      continue;
    }
    try {
      const indexDocument = await getStoredJson(indexPath, storageOptions);
      const recordPath = indexDocument?.recordPath
        || (indexDocument?.record?.id ? getRecordPath(indexDocument.record.id) : null);
      if (recordPath) {
        const currentRecord = await getStoredJson(recordPath, storageOptions);
        if (currentRecord && buildRecordIndexPath(currentRecord) === indexPath) {
          continue;
        }
      }
      if (!dryRun) {
        await deleteStoragePaths([indexPath], storageOptions);
      }
      summary.repaired += 1;
    } catch {
      summary.failed += 1;
    }
  }
}

export async function migrateRecordIndex({
  dryRun = false,
  onProgress = () => {},
  blobSdk,
  leaseHeartbeatMs,
  leasePollIntervalMs,
  leaseTtlMs,
  leaseWaitTimeoutMs
} = {}) {
  assertStorageConfigured();
  const summary = {
    scanned: 0,
    created: 0,
    repaired: 0,
    skipped: 0,
    failed: 0
  };
  const storageOptions = blobSdk ? { blobSdk } : {};
  const leaseOptions = {
    ...storageOptions,
    leaseHeartbeatMs,
    leasePollIntervalMs,
    leaseTtlMs,
    leaseWaitTimeoutMs
  };
  const maintenance = await acquireRecordIndexMaintenanceLock(leaseOptions);

  try {
    await waitForOrdinaryLeases(leaseOptions);
    maintenance.heartbeat.assertHealthy();
    if (!dryRun) {
      await deleteStoragePaths([RECORD_INDEX_READY_PATH], storageOptions);
    }

    const expectedPaths = new Set();
    const seenIds = new Set();
    const recordPaths = await listAllStoragePaths(RECORD_PREFIX, storageOptions);

    for (const recordPath of recordPaths) {
      summary.scanned += 1;
      try {
        const record = await getStoredJson(recordPath, storageOptions);
        if (!record || typeof record.id !== "string") {
          throw new Error(`Canonical record ${recordPath} is invalid`);
        }
        if (seenIds.has(record.id)) {
          throw new Error(`Duplicate canonical record ID ${record.id}`);
        }
        seenIds.add(record.id);
        const expectedPath = await ensureRecordIndex(record, {
          dryRun,
          summary,
          storageOptions
        });
        expectedPaths.add(expectedPath);
      } catch {
        summary.failed += 1;
      }
      await onProgress({ ...summary });
    }

    if (summary.failed === 0) {
      await removeOrphanIndexes(expectedPaths, { dryRun, summary, storageOptions });
    }
    if (!dryRun && summary.failed === 0) {
      maintenance.heartbeat.assertHealthy();
      await deleteStoragePaths([RECORD_INDEX_DIRTY_PATH], storageOptions);
      await writeRecordIndexReadyMarker({
        version: 1,
        completedAt: new Date().toISOString()
      }, storageOptions);
    }
    return summary;
  } finally {
    await maintenance.heartbeat.stop();
    await deleteOwnedLease(maintenance.lease, storageOptions);
  }
}

export async function getRecord(id) {
  assertStorageConfigured();

  if (shouldUseBlobStore()) {
    const { get } = await getBlobSdk();
    try {
      const result = await get(getRecordPath(id), { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) {
        return null;
      }
      return JSON.parse(await streamToText(result.stream));
    } catch (error) {
      if (isMissingBlobError(error)) {
        return null;
      }
      throw error;
    }
  }

  await ensureLocalStore();
  try {
    const raw = await fs.readFile(resolveLocalStoragePath(getRecordPath(id)), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function getUploadContent(record) {
  if (currentUploadKind(record) === "zip") {
    return getSiteFileContent(record, record.siteIndexPath || "index.html");
  }

  const upload = await getStoredFile(record.blobPath || getUploadPath(record.id));
  if (!upload) {
    return null;
  }
  return {
    ...upload,
    contentType: "text/html; charset=utf-8"
  };
}

export async function getSiteFileContent(record, pathname) {
  if (currentUploadKind(record) !== "zip") {
    return null;
  }
  const sitePath = normalizeSitePath(pathname || record.siteIndexPath || "index.html");
  const siteFile = currentSiteFiles(record).find((file) => file.pathname === sitePath);
  if (!siteFile) {
    return null;
  }
  const upload = await getStoredFile(siteFile.blobPath);
  if (!upload) {
    return null;
  }
  return {
    ...upload,
    contentType: siteFile.contentType || "application/octet-stream"
  };
}

export async function getDownloadContent(record) {
  if (currentUploadKind(record) === "zip") {
    const upload = await getStoredFile(record.sourceBlobPath || getPackageSourcePath(record.id));
    if (!upload) {
      return null;
    }
    return {
      ...upload,
      contentType: "application/zip"
    };
  }

  return getUploadContent(record);
}

export async function savePreviousVersion(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => savePreviousVersion(record));
  }
  await assertRecordIndexAvailable();
  const baseVersion = {
    originalName: record.originalName,
    title: record.title,
    description: record.description || "",
    documentType: record.documentType,
    size: record.size,
    uploadedAt: record.uploadedAt,
    uploadKind: currentUploadKind(record)
  };

  if (currentUploadKind(record) === "zip") {
    const source = await getStoredFile(record.sourceBlobPath || getPackageSourcePath(record.id));
    if (!source) {
      const missingError = new Error("Current ZIP package is missing");
      missingError.status = 404;
      throw missingError;
    }
    const packageBlob = await putStoredFile(getPreviousPackageSourcePath(record.id), await bodyToBuffer(source.body), {
      allowOverwrite: true,
      contentType: "application/zip"
    });
    const siteFiles = [];
    for (const siteFile of currentSiteFiles(record)) {
      const sourceFile = await getStoredFile(siteFile.blobPath);
      if (!sourceFile) {
        const missingError = new Error("Current ZIP asset is missing");
        missingError.status = 404;
        throw missingError;
      }
      const stored = await putStoredFile(
        getPreviousSiteFilePath(record.id, siteFile.pathname),
        await bodyToBuffer(sourceFile.body),
        {
          allowOverwrite: true,
          contentType: siteFile.contentType || "application/octet-stream"
        }
      );
      siteFiles.push({
        pathname: siteFile.pathname,
        blobPath: stored.pathname,
        contentType: siteFile.contentType || "application/octet-stream",
        size: siteFile.size
      });
    }
    return {
      ...baseVersion,
      sourceBlobPath: packageBlob.pathname,
      sourceBlobUrl: packageBlob.url,
      siteIndexPath: record.siteIndexPath || "index.html",
      siteFiles
    };
  }

  const source = await getStoredFile(record.blobPath || getUploadPath(record.id));
  if (!source) {
    const missingError = new Error("Current HTML file is missing");
    missingError.status = 404;
    throw missingError;
  }
  const uploadBlob = await putStoredFile(getPreviousUploadPath(record.id), await bodyToBuffer(source.body), {
    allowOverwrite: true,
    contentType: "text/html; charset=utf-8"
  });
  return {
    ...baseVersion,
    blobPath: uploadBlob.pathname,
    blobUrl: uploadBlob.url
  };
}

export async function restorePreviousVersion(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => restorePreviousVersion(record));
  }
  await assertRecordIndexAvailable();
  const previous = record.previousVersion;
  if (!previous) {
    const versionError = new Error("No previous version is available");
    versionError.status = 409;
    throw versionError;
  }

  let restoredRecord;
  if (previous.uploadKind === "zip") {
    const source = await getStoredFile(previous.sourceBlobPath);
    if (!source) {
      const missingError = new Error("Previous ZIP package is missing");
      missingError.status = 404;
      throw missingError;
    }
    const packageBlob = await putStoredFile(getPackageSourcePath(record.id), await bodyToBuffer(source.body), {
      allowOverwrite: true,
      contentType: "application/zip"
    });
    const siteFiles = [];
    for (const previousFile of Array.isArray(previous.siteFiles) ? previous.siteFiles : []) {
      const sourceFile = await getStoredFile(previousFile.blobPath);
      if (!sourceFile) {
        const missingError = new Error("Previous ZIP asset is missing");
        missingError.status = 404;
        throw missingError;
      }
      const stored = await putStoredFile(
        getSiteFilePath(record.id, previousFile.pathname),
        await bodyToBuffer(sourceFile.body),
        {
          allowOverwrite: true,
          contentType: previousFile.contentType || "application/octet-stream"
        }
      );
      siteFiles.push({
        pathname: previousFile.pathname,
        blobPath: stored.pathname,
        contentType: previousFile.contentType || "application/octet-stream",
        size: previousFile.size
      });
    }
    restoredRecord = {
      ...record,
      originalName: previous.originalName,
      title: previous.title,
      description: previous.description || "",
      documentType: previous.documentType,
      tags: undefined,
      size: previous.size,
      uploadedAt: new Date().toISOString(),
      uploadKind: "zip",
      url: `/view/${record.id}/`,
      blobPath: undefined,
      blobUrl: undefined,
      sourceBlobPath: packageBlob.pathname,
      sourceBlobUrl: packageBlob.url,
      siteIndexPath: previous.siteIndexPath || "index.html",
      siteFiles,
      previousVersion: undefined
    };
  } else {
    const source = await getStoredFile(previous.blobPath);
    if (!source) {
      const missingError = new Error("Previous HTML file is missing");
      missingError.status = 404;
      throw missingError;
    }
    const uploadBlob = await putStoredFile(getUploadPath(record.id), await bodyToBuffer(source.body), {
      allowOverwrite: true,
      contentType: "text/html; charset=utf-8"
    });
    restoredRecord = {
      ...record,
      originalName: previous.originalName,
      title: previous.title,
      description: previous.description || "",
      documentType: previous.documentType,
      tags: undefined,
      size: previous.size,
      uploadedAt: new Date().toISOString(),
      uploadKind: "html",
      url: `/view/${record.id}`,
      blobPath: uploadBlob.pathname,
      blobUrl: uploadBlob.url,
      sourceBlobPath: undefined,
      sourceBlobUrl: undefined,
      siteIndexPath: undefined,
      siteFiles: undefined,
      previousVersion: undefined
    };
  }

  const saved = await saveIndexedRecord(restoredRecord, record);
  await deleteObsoleteUploadFiles(record, saved);
  await deletePreviousVersion(record);
  return saved;
}

export async function deleteCurrentUpload(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => deleteCurrentUpload(record));
  }
  await assertRecordIndexAvailable();
  await deleteStoredFiles(currentUploadPaths(record));
}

export async function deleteObsoleteUploadFiles(previousRecord, nextRecord) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => deleteObsoleteUploadFiles(previousRecord, nextRecord));
  }
  await assertRecordIndexAvailable();
  const nextPaths = new Set(currentUploadPaths(nextRecord));
  await deleteStoredFiles(currentUploadPaths(previousRecord).filter((storagePath) => !nextPaths.has(storagePath)));
}

export async function deletePreviousVersion(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => deletePreviousVersion(record));
  }
  await assertRecordIndexAvailable();
  const previous = record.previousVersion;
  if (!previous) {
    return;
  }
  if (previous.uploadKind === "zip") {
    await deleteStoredFiles([
      previous.sourceBlobPath,
      ...(Array.isArray(previous.siteFiles) ? previous.siteFiles.map((file) => file.blobPath) : [])
    ]);
    return;
  }
  await deleteStoredFiles([previous.blobPath]);
}

export async function deleteUpload(record) {
  if (!writerLeaseContext.getStore()) {
    return withRecordMutation(() => deleteUpload(record));
  }
  await assertRecordIndexAvailable();
  await deleteCurrentUpload(record);
  await deletePreviousVersion(record);
  await deleteIndexedRecord(record);
}

function sortNewestFirst(first, second) {
  return new Date(second.uploadedAt).getTime() - new Date(first.uploadedAt).getTime();
}
