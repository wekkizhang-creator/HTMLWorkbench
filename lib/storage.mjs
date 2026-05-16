import fs from "node:fs/promises";
import path from "node:path";
import { getRecordPath, getUploadPath, RECORD_PREFIX } from "./constants.mjs";

const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RECORD_DIR = path.join(DATA_DIR, "records");

function isVercelProduction() {
  return process.env.VERCEL === "1" || process.env.VERCEL_ENV;
}

function hasBlobToken() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function shouldUseBlobStore() {
  return hasBlobToken();
}

function assertStorageConfigured() {
  if (isVercelProduction() && !hasBlobToken()) {
    const configError = new Error("Vercel 部署需要先连接 Vercel Blob，并配置 BLOB_READ_WRITE_TOKEN 环境变量");
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

function isMissingBlobError(error) {
  return error?.name === "BlobNotFoundError" || error?.status === 404 || /not found/i.test(error?.message || "");
}

async function ensureLocalStore() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(RECORD_DIR, { recursive: true });
}

export async function saveUpload(id, fileBuffer) {
  assertStorageConfigured();
  const uploadPath = getUploadPath(id);

  if (shouldUseBlobStore()) {
    const { put } = await getBlobSdk();
    return put(uploadPath, fileBuffer, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "text/html; charset=utf-8"
    });
  }

  await ensureLocalStore();
  await fs.writeFile(path.join(UPLOAD_DIR, `${id}.html`), fileBuffer);
  return {
    pathname: uploadPath,
    url: uploadPath,
    downloadUrl: uploadPath
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
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8"
    });
    return normalizedRecord;
  }

  await ensureLocalStore();
  await fs.writeFile(path.join(RECORD_DIR, `${record.id}.json`), `${body}\n`, "utf8");
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
    const raw = await fs.readFile(path.join(RECORD_DIR, `${id}.json`), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function getUploadContent(record) {
  assertStorageConfigured();

  if (shouldUseBlobStore()) {
    const { get } = await getBlobSdk();
    const result = await get(record.blobPath || getUploadPath(record.id), { access: "private" });
    if (!result || result.statusCode !== 200) {
      return null;
    }
    return {
      body: result.stream,
      contentLength: result.blob.size
    };
  }

  await ensureLocalStore();
  try {
    const fileBuffer = await fs.readFile(path.join(UPLOAD_DIR, `${record.id}.html`));
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

export async function deleteUpload(record) {
  assertStorageConfigured();

  if (shouldUseBlobStore()) {
    const { del } = await getBlobSdk();
    await del([record.blobPath || getUploadPath(record.id), record.recordPath || getRecordPath(record.id)]);
    return;
  }

  await ensureLocalStore();
  await fs.unlink(path.join(UPLOAD_DIR, `${record.id}.html`)).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await fs.unlink(path.join(RECORD_DIR, `${record.id}.json`)).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function sortNewestFirst(first, second) {
  return new Date(second.uploadedAt).getTime() - new Date(first.uploadedAt).getTime();
}
