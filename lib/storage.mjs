import fs from "node:fs/promises";
import path from "node:path";
import {
  getPackageSourcePath,
  getPreviousPackageSourcePath,
  getPreviousSiteFilePath,
  getPreviousUploadPath,
  getRecordPath,
  getSiteFilePath,
  getUploadPath,
  RECORD_PREFIX
} from "./constants.mjs";

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
  await fs.writeFile(localPath, body);
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
  try {
    const fileBuffer = await fs.readFile(resolveLocalStoragePath(storagePath));
    return {
      body: fileBuffer,
      contentLength: fileBuffer.length
    };
  } catch (error) {
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
    await fs.rm(resolveLocalStoragePath(storagePath), { force: true });
  }));
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
  return putStoredFile(getUploadPath(id), fileBuffer, {
    allowOverwrite: options.allowOverwrite,
    contentType: "text/html; charset=utf-8"
  });
}

export async function savePackageUpload(id, packageBuffer, files, options = {}) {
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
  const recordPath = getRecordPath(record.id);
  const normalizedRecord = {
    ...record,
    recordPath
  };
  const body = JSON.stringify(normalizedRecord, null, 2);

  if (shouldUseBlobStore()) {
    const { put } = await getBlobSdk();
    await put(recordPath, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8"
    });
    return normalizedRecord;
  }

  await ensureLocalStore();
  await fs.writeFile(resolveLocalStoragePath(recordPath), `${body}\n`, "utf8");
  return normalizedRecord;
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
  const baseVersion = {
    originalName: record.originalName,
    title: record.title,
    description: record.description || "",
    documentType: record.documentType,
    tags: Array.isArray(record.tags) ? record.tags : [],
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
      tags: Array.isArray(previous.tags) ? previous.tags : [],
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
      tags: Array.isArray(previous.tags) ? previous.tags : [],
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

  const saved = await saveRecord(restoredRecord);
  await deleteObsoleteUploadFiles(record, saved);
  await deletePreviousVersion(record);
  return saved;
}

export async function deleteCurrentUpload(record) {
  await deleteStoredFiles(currentUploadPaths(record));
}

export async function deleteObsoleteUploadFiles(previousRecord, nextRecord) {
  const nextPaths = new Set(currentUploadPaths(nextRecord));
  await deleteStoredFiles(currentUploadPaths(previousRecord).filter((storagePath) => !nextPaths.has(storagePath)));
}

export async function deletePreviousVersion(record) {
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
  await deleteCurrentUpload(record);
  await deletePreviousVersion(record);
  await deleteStoredFiles([record.recordPath || getRecordPath(record.id)]);
}

function sortNewestFirst(first, second) {
  return new Date(second.uploadedAt).getTime() - new Date(first.uploadedAt).getTime();
}
