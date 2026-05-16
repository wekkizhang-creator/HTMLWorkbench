import { randomUUID } from "node:crypto";
import { MAX_UPLOAD_BYTES, HTML_EXTENSIONS } from "./constants.mjs";

const STOP_WORDS = new Set([
  "html",
  "head",
  "body",
  "script",
  "style",
  "class",
  "section",
  "button",
  "input",
  "content",
  "charset",
  "viewport",
  "width",
  "device",
  "initial",
  "scale",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "that",
  "with",
  "from",
  "your",
  "you",
  "and",
  "the",
  "for",
  "page",
  "site",
  "web",
  "document",
  "页面",
  "文件",
  "内容",
  "网站",
  "按钮",
  "链接",
  "更多",
  "首页"
]);

export function publicRecord(record) {
  return {
    id: record.id,
    originalName: record.originalName,
    title: record.title,
    description: record.description || "",
    tags: Array.isArray(record.tags) ? record.tags : [],
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
  const analysis = analyzeHtml(fileBuffer, originalName);
  return {
    id,
    originalName,
    title: analysis.title,
    description: analysis.description,
    tags: analysis.tags,
    size: fileBuffer.length,
    url: `/view/${id}`,
    uploadedAt: new Date().toISOString(),
    blobPath: uploadBlob.pathname,
    blobUrl: uploadBlob.url,
    recordPath: `records/${id}.json`
  };
}

export function analyzeHtml(fileBuffer, fallback) {
  const html = Buffer.from(fileBuffer).slice(0, 512 * 1024).toString("utf8");
  const title = extractTitleFromHtml(html, fallback);
  const metaDescription = extractMetaContent(html, "description");
  const metaKeywords = extractMetaContent(html, "keywords")
    .split(/[,，、;；]/)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const headings = extractHeadings(html);
  const visibleText = extractVisibleText(html);
  const description = buildDescription({
    metaDescription,
    headings,
    title,
    visibleText,
    fallback
  });
  const tags = buildTags({
    title,
    description,
    headings,
    visibleText,
    metaKeywords,
    fallback
  });

  return {
    title,
    description,
    tags
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

function buildTags({ title, description, headings, visibleText, metaKeywords, fallback }) {
  const scores = new Map();
  for (const keyword of metaKeywords) {
    addScore(scores, keyword, 12);
  }
  for (const phrase of [title, ...headings, fallback]) {
    for (const token of tokenize(phrase)) {
      addScore(scores, token, 6);
    }
  }
  for (const token of tokenize(`${description} ${visibleText}`)) {
    addScore(scores, token, 1);
  }

  return Array.from(scores.entries())
    .filter(([tag]) => !STOP_WORDS.has(tag.toLowerCase()))
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0], "zh-CN"))
    .map(([tag]) => tag)
    .slice(0, 8);
}

function tokenize(text) {
  const normalized = normalizeText(text);
  const tokens = [];
  for (const match of normalized.matchAll(/[\u4e00-\u9fa5]{2,10}|[A-Za-z][A-Za-z0-9-]{2,28}/g)) {
    const value = match[0].trim();
    if (!value || /^\d+$/.test(value)) {
      continue;
    }
    tokens.push(value.length > 12 && /[\u4e00-\u9fa5]/.test(value) ? value.slice(0, 12) : value);
  }
  return tokens;
}

function addScore(scores, tag, score) {
  const normalized = normalizeTag(tag);
  if (!normalized || STOP_WORDS.has(normalized.toLowerCase())) {
    return;
  }
  scores.set(normalized, (scores.get(normalized) || 0) + score);
}

function normalizeTag(value) {
  const normalized = normalizeText(value).replace(/^[-_]+|[-_]+$/g, "").slice(0, 24);
  return /^[A-Za-z0-9-]+$/.test(normalized) ? normalized.toLowerCase() : normalized;
}

function trimSentence(value, maxLength) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
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
