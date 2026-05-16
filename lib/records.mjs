import { randomUUID } from "node:crypto";
import { MAX_UPLOAD_BYTES, HTML_EXTENSIONS } from "./constants.mjs";

export function publicRecord(record) {
  return {
    id: record.id,
    originalName: record.originalName,
    title: record.title,
    size: record.size,
    url: record.url,
    uploadedAt: record.uploadedAt
  };
}

export function publicRecords(records) {
  return records.map(publicRecord);
}

export function getSafeFileName(name) {
  return String(name || "untitled.html").replaceAll("\\", "/").split("/").pop().trim() || "untitled.html";
}

export function assertHtmlFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    const uploadError = new Error("没有找到 HTML 文件");
    uploadError.status = 400;
    throw uploadError;
  }

  const safeName = getSafeFileName(file.name);
  const extension = safeName.split(".").pop().toLowerCase();
  if (!HTML_EXTENSIONS.has(extension)) {
    const uploadError = new Error("只能上传 .html 或 .htm 文件");
    uploadError.status = 415;
    throw uploadError;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const uploadError = new Error("文件超过 4 MB 限制");
    uploadError.status = 413;
    throw uploadError;
  }

  if (file.size === 0) {
    const uploadError = new Error("上传的 HTML 文件为空");
    uploadError.status = 400;
    throw uploadError;
  }

  return safeName;
}

export function buildRecord({ fileBuffer, originalName, uploadBlob }) {
  const id = randomUUID();
  return {
    id,
    originalName,
    title: extractTitle(fileBuffer, originalName),
    size: fileBuffer.length,
    url: `/view/${id}`,
    uploadedAt: new Date().toISOString(),
    blobPath: uploadBlob.pathname,
    blobUrl: uploadBlob.url,
    recordPath: `records/${id}.json`
  };
}

export function extractTitle(fileBuffer, fallback) {
  const sample = Buffer.from(fileBuffer).slice(0, 120 * 1024).toString("utf8");
  const match = sample.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return fallback;
  }
  return match[1].replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

export function assertRecordId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
    const idError = new Error("记录 ID 不合法");
    idError.status = 400;
    throw idError;
  }
}
