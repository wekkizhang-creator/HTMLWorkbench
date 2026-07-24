import fs from "node:fs/promises";
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
  RECORD_INDEX_MAINTENANCE_LOCK_PATH,
  RECORD_INDEX_PREFIX,
  RECORD_INDEX_READY_PATH,
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
      const result = await get(storagePath, { access: "private" });
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

function recordIndexMaintenance() {
  const error = new Error("Upload records are temporarily unavailable during index maintenance");
  error.status = 503;
  error.code = "record_index_maintenance";
  return error;
}

function isAlreadyExistingLock(error) {
  return error?.code === "EEXIST"
    || error?.status === 409
    || /already exists|overwrite/i.test(error?.message || "");
}

async function storedPathExists(storagePath, options = {}) {
  if (usesBlobStore(options)) {
    const { get } = await resolveBlobSdk(options);
    try {
      const result = await get(storagePath, { access: "private" });
      return Boolean(result && result.statusCode === 200);
    } catch (error) {
      if (isMissingBlobError(error)) return false;
      throw error;
    }
  }

  await ensureLocalStore();
  try {
    await fs.access(resolveLocalStoragePath(storagePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertRecordIndexAvailable(options = {}) {
  assertStorageConfigured();
  if (await storedPathExists(RECORD_INDEX_MAINTENANCE_LOCK_PATH, options)) {
    throw recordIndexMaintenance();
  }
}

async function acquireRecordIndexMaintenanceLock(options = {}) {
  const owner = randomUUID();
  const lock = {
    version: 1,
    owner,
    startedAt: new Date().toISOString()
  };

  if (usesBlobStore(options)) {
    const { put } = await resolveBlobSdk(options);
    try {
      await put(RECORD_INDEX_MAINTENANCE_LOCK_PATH, JSON.stringify(lock, null, 2), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        contentType: "application/json; charset=utf-8"
      });
    } catch (error) {
      if (isAlreadyExistingLock(error)) throw recordIndexMaintenance();
      throw error;
    }
  } else {
    await ensureLocalStore();
    const lockPath = resolveLocalStoragePath(RECORD_INDEX_MAINTENANCE_LOCK_PATH);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    let handle;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } catch (error) {
      if (isAlreadyExistingLock(error)) throw recordIndexMaintenance();
      if (handle) await fs.rm(lockPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle?.close();
    }
  }

  return async () => {
    const current = await getStoredJson(RECORD_INDEX_MAINTENANCE_LOCK_PATH, options);
    if (current?.owner === owner) {
      await deleteStoragePaths([RECORD_INDEX_MAINTENANCE_LOCK_PATH], options);
    }
  };
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
  await assertRecordIndexAvailable();
  return putStoredFile(getUploadPath(id), fileBuffer, {
    allowOverwrite: options.allowOverwrite,
    contentType: "text/html; charset=utf-8"
  });
}

export async function savePackageUpload(id, packageBuffer, files, options = {}) {
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

async function assertRecordIndexReady(options = {}) {
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

export async function saveIndexedRecord(record, previousRecord) {
  assertStorageConfigured();
  await assertRecordIndexAvailable();
  const initializeReadyMarker = !(await hasRecordIndexReadyMarker())
    && !(await hasCanonicalRecords());
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
    await writeRecordIndexReadyMarker();
  }
  return savedRecord;
}

export async function deleteIndexedRecord(record) {
  await assertRecordIndexAvailable();
  await deleteStoredFiles([
    record.recordPath || getRecordPath(record.id),
    buildRecordIndexPath(record)
  ]);
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
        const stored = await get(blob.pathname, { access: "private" });
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
  await assertRecordIndexAvailable(options.blobSdk ? { blobSdk: options.blobSdk } : {});
  const limit = Number(options.limit);
  const filters = normalizeListFilters(options);
  const cursorState = options.cursor
    ? decodePageCursor(options.cursor, filters)
    : { storageCursor: null };
  const storageOptions = options.blobSdk ? { blobSdk: options.blobSdk } : {};
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
          const result = await get(blob.pathname, { access: "private" });
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
  blobSdk
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
  let releaseMaintenanceLock;

  if (dryRun) {
    await assertRecordIndexAvailable(storageOptions);
  } else {
    releaseMaintenanceLock = await acquireRecordIndexMaintenanceLock(storageOptions);
  }

  try {
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
      await writeRecordIndexReadyMarker({
        version: 1,
        completedAt: new Date().toISOString()
      }, storageOptions);
    }
    return summary;
  } finally {
    await releaseMaintenanceLock?.();
  }
}

export async function getRecord(id) {
  assertStorageConfigured();

  if (shouldUseBlobStore()) {
    const { get } = await getBlobSdk();
    try {
      const result = await get(getRecordPath(id), { access: "private" });
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
  await assertRecordIndexAvailable();
  await deleteStoredFiles(currentUploadPaths(record));
}

export async function deleteObsoleteUploadFiles(previousRecord, nextRecord) {
  await assertRecordIndexAvailable();
  const nextPaths = new Set(currentUploadPaths(nextRecord));
  await deleteStoredFiles(currentUploadPaths(previousRecord).filter((storagePath) => !nextPaths.has(storagePath)));
}

export async function deletePreviousVersion(record) {
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
  await assertRecordIndexAvailable();
  await deleteCurrentUpload(record);
  await deletePreviousVersion(record);
  await deleteIndexedRecord(record);
}

function sortNewestFirst(first, second) {
  return new Date(second.uploadedAt).getTime() - new Date(first.uploadedAt).getTime();
}
