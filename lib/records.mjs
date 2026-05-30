import { randomUUID } from "node:crypto";
import { MAX_UPLOAD_BYTES, HTML_EXTENSIONS, UPLOAD_EXTENSIONS, ZIP_EXTENSIONS } from "./constants.mjs";

export const DEFAULT_DOCUMENT_TYPE = "其他";
export const BASE_DOCUMENT_TYPES = ["分析报告", "原型", "其他"];

export function normalizeDocumentType(value) {
  const normalized = normalizeText(value).replace(/[\r\n\t]+/g, " ").slice(0, 24);
  return normalized || DEFAULT_DOCUMENT_TYPE;
}

export function normalizeTitle(value) {
  return normalizeText(value).replace(/[\r\n\t]+/g, " ").slice(0, 120);
}

export function publicRecord(record) {
  return {
    id: record.id,
    originalName: record.originalName,
    title: record.title,
    description: record.description || "",
    documentType: normalizeDocumentType(record.documentType),
    hasPreviousVersion: Boolean(record.previousVersion),
    uploadKind: record.uploadKind || "html",
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
  const safeName = assertUploadFile(file);
  const extension = safeName.split(".").pop().toLowerCase();
  if (!HTML_EXTENSIONS.has(extension)) {
    const uploadError = new Error("只能上传 .html 或 .htm 文件");
    uploadError.status = 415;
    throw uploadError;
  }
  return safeName;
}

export function assertUploadFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") {
    const uploadError = new Error("没有找到上传文件");
    uploadError.status = 400;
    throw uploadError;
  }

  const safeName = getSafeFileName(file.name);
  const extension = safeName.split(".").pop().toLowerCase();
  if (!UPLOAD_EXTENSIONS.has(extension)) {
    const uploadError = new Error("只能上传 .html、.htm 或 .zip 文件");
    uploadError.status = 415;
    throw uploadError;
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    const uploadError = new Error("文件超过 4 MB 限制");
    uploadError.status = 413;
    throw uploadError;
  }

  if (file.size === 0) {
    const uploadError = new Error("上传的文件为空");
    uploadError.status = 400;
    throw uploadError;
  }

  return safeName;
}

export function getUploadKind(originalName) {
  const extension = getSafeFileName(originalName).split(".").pop().toLowerCase();
  return ZIP_EXTENSIONS.has(extension) ? "zip" : "html";
}

export function buildRecord({ fileBuffer, originalName, uploadBlob, documentType, title }) {
  const id = randomUUID();
  const analysis = analyzeHtml(fileBuffer, originalName);
  return {
    id,
    originalName,
    title: normalizeTitle(title) || analysis.title,
    description: analysis.description,
    documentType: normalizeDocumentType(documentType),
    uploadKind: "html",
    size: fileBuffer.length,
    url: `/view/${id}`,
    uploadedAt: new Date().toISOString(),
    blobPath: uploadBlob.pathname,
    blobUrl: uploadBlob.url,
    recordPath: `records/${id}.json`
  };
}

export function buildPackageRecord({ indexBuffer, originalName, packageBlob, siteFiles, sourceSize, documentType, title }) {
  const id = randomUUID();
  const analysis = analyzeHtml(indexBuffer, originalName);
  return {
    id,
    originalName,
    title: normalizeTitle(title) || analysis.title,
    description: analysis.description,
    documentType: normalizeDocumentType(documentType),
    uploadKind: "zip",
    size: sourceSize,
    url: `/view/${id}/`,
    uploadedAt: new Date().toISOString(),
    sourceBlobPath: packageBlob.pathname,
    sourceBlobUrl: packageBlob.url,
    siteFiles,
    siteIndexPath: "index.html",
    recordPath: `records/${id}.json`
  };
}

export function buildReplacementRecord({ record, fileBuffer, originalName, uploadBlob, title }) {
  const analysis = analyzeHtml(fileBuffer, originalName);
  return {
    ...record,
    originalName,
    title: normalizeTitle(title) || analysis.title,
    description: analysis.description,
    documentType: normalizeDocumentType(record.documentType),
    uploadKind: "html",
    tags: undefined,
    size: fileBuffer.length,
    url: `/view/${record.id}`,
    uploadedAt: new Date().toISOString(),
    blobPath: uploadBlob.pathname || record.blobPath,
    blobUrl: uploadBlob.url || record.blobUrl,
    siteFiles: undefined,
    siteIndexPath: undefined,
    sourceBlobPath: undefined,
    sourceBlobUrl: undefined,
    recordPath: record.recordPath || `records/${record.id}.json`
  };
}

export function buildReplacementPackageRecord({ record, indexBuffer, originalName, packageBlob, siteFiles, sourceSize, title }) {
  const analysis = analyzeHtml(indexBuffer, originalName);
  return {
    ...record,
    originalName,
    title: normalizeTitle(title) || analysis.title,
    description: analysis.description,
    documentType: normalizeDocumentType(record.documentType),
    uploadKind: "zip",
    tags: undefined,
    size: sourceSize,
    url: `/view/${record.id}/`,
    uploadedAt: new Date().toISOString(),
    blobPath: undefined,
    blobUrl: undefined,
    sourceBlobPath: packageBlob.pathname,
    sourceBlobUrl: packageBlob.url,
    siteFiles,
    siteIndexPath: "index.html",
    recordPath: record.recordPath || `records/${record.id}.json`
  };
}

export function analyzeHtml(fileBuffer, fallback) {
  const html = Buffer.from(fileBuffer).slice(0, 512 * 1024).toString("utf8");
  const title = extractTitleFromHtml(html, fallback);
  const metaDescription = extractMetaContent(html, "description");
  const headings = extractHeadings(html);
  const visibleText = extractVisibleText(html);
  const description = buildDescription({
    metaDescription,
    headings,
    title,
    visibleText,
    fallback
  });

  return {
    title,
    description
  };
}

export function extractTitle(fileBuffer, fallback) {
  const html = Buffer.from(fileBuffer).slice(0, 120 * 1024).toString("utf8");
  return extractTitleFromHtml(html, fallback);
}

function extractTitleFromHtml(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return fallback;
  }
  return normalizeText(stripTags(match[1])).slice(0, 120) || fallback;
}

function extractMetaContent(html, name) {
  const pattern = new RegExp(`<meta\\s+[^>]*(?:name|property)=["'](?:${name}|og:${name})["'][^>]*>`, "i");
  const tag = html.match(pattern)?.[0] || "";
  if (!tag) {
    return "";
  }
  const content = tag.match(/\scontent=["']([^"']*)["']/i)?.[1] || "";
  return normalizeText(decodeEntities(content));
}

function extractHeadings(html) {
  return Array.from(html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi))
    .map((match) => normalizeText(stripTags(match[1])))
    .filter(Boolean)
    .slice(0, 8);
}

function extractVisibleText(html) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return normalizeText(decodeEntities(cleaned));
}

function buildDescription({ metaDescription, headings, title, visibleText, fallback }) {
  const candidates = [
    metaDescription,
    headings.find((heading) => heading !== title),
    visibleText
  ].filter(Boolean);
  const source = candidates.find((item) => item.length > 12) || title || fallback;
  return trimSentence(source, 160);
}

function trimSentence(value, maxLength) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function normalizeText(value) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function assertRecordId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) {
    const idError = new Error("记录 ID 不合法");
    idError.status = 400;
    throw idError;
  }
}
