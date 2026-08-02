import { inflateRawSync } from "node:zlib";
import { MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES } from "./constants.mjs";

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const CONTENT_TYPES = new Map([
  ["css", "text/css; charset=utf-8"],
  ["gif", "image/gif"],
  ["html", "text/html; charset=utf-8"],
  ["htm", "text/html; charset=utf-8"],
  ["ico", "image/x-icon"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["js", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"],
  ["map", "application/json; charset=utf-8"],
  ["png", "image/png"],
  ["svg", "image/svg+xml; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"],
  ["webp", "image/webp"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"]
]);

export function parseZipWebsite(zipBuffer) {
  const entries = readZipEntries(Buffer.from(zipBuffer));
  const indexPath = findIndexPath(entries);
  const prefix = indexPath === "index.html" ? "" : indexPath.slice(0, -("index.html".length));
  const files = entries
    .filter((entry) => !prefix || entry.pathname.startsWith(prefix))
    .map((entry) => ({
      ...entry,
      pathname: prefix ? entry.pathname.slice(prefix.length) : entry.pathname
    }))
    .filter((entry) => entry.pathname && !entry.pathname.endsWith("/"));

  const siteFiles = dedupeFiles(files).filter((entry) => !isIgnoredEntry(entry.pathname));
  const index = siteFiles.find((entry) => entry.pathname === "index.html");
  if (!index) {
    throwZipError("压缩包里没有找到 index.html");
  }

  return {
    entryCount: siteFiles.length,
    files: siteFiles.map((entry) => ({
      pathname: entry.pathname,
      buffer: entry.buffer,
      contentType: getContentType(entry.pathname),
      size: entry.buffer.length
    })),
    indexHtml: index.buffer,
    totalSize: siteFiles.reduce((sum, entry) => sum + entry.buffer.length, 0)
  };
}

export function getContentType(pathname) {
  const extension = pathname.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPES.get(extension) || "application/octet-stream";
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount > MAX_ZIP_ENTRIES) {
    throwZipError(`压缩包文件数量超过 ${MAX_ZIP_ENTRIES} 个`);
  }
  if (centralOffset + centralSize > buffer.length) {
    throwZipError("压缩包目录信息不完整");
  }

  const entries = [];
  let offset = centralOffset;
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throwZipError("压缩包目录格式不受支持");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const zipPath = normalizeZipPath(rawName.toString(flags & 0x0800 ? "utf8" : "utf8"));

    offset += 46 + nameLength + extraLength + commentLength;
    if (!zipPath || zipPath.endsWith("/") || isIgnoredEntry(zipPath)) {
      continue;
    }

    totalSize += uncompressedSize;
    if (totalSize > MAX_ZIP_UNCOMPRESSED_BYTES) {
      throwZipError("压缩包解压后文件总大小超过限制");
    }

    const bufferContent = readZipEntryBuffer(buffer, {
      compressedSize,
      localHeaderOffset,
      method,
      uncompressedSize
    });
    entries.push({
      buffer: bufferContent,
      pathname: zipPath
    });
  }
  return entries;
}

function readZipEntryBuffer(buffer, entry) {
  if (buffer.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throwZipError("压缩包文件头格式不受支持");
  }
  const nameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throwZipError("压缩包文件内容不完整");
  }

  if (entry.method === 0) {
    const stored = Buffer.from(buffer.subarray(dataStart, dataEnd));
    if (stored.length !== entry.uncompressedSize) {
      throwZipError("ZIP entry decompressed size does not match its declared size");
    }
    return stored;
  }
  if (entry.method === 8) {
    try {
      const inflated = inflateRawSync(buffer.subarray(dataStart, dataEnd), {
        maxOutputLength: Math.max(entry.uncompressedSize, 1)
      });
      if (inflated.length !== entry.uncompressedSize) {
        throwZipError("ZIP entry decompressed size does not match its declared size");
      }
      return inflated;
    } catch (error) {
      if (error?.status === 400) {
        throw error;
      }
      throwZipError("ZIP entry decompressed size exceeds its declared size or size limit");
    }
  }
  throwZipError("压缩包包含不支持的压缩方式");
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throwZipError("无法识别压缩包");
}

function findIndexPath(entries) {
  const indexes = entries
    .map((entry) => entry.pathname)
    .filter((pathname) => pathname === "index.html" || pathname.endsWith("/index.html"))
    .sort((first, second) => first.split("/").length - second.split("/").length || first.localeCompare(second));
  if (!indexes.length) {
    throwZipError("压缩包里没有找到 index.html");
  }
  return indexes[0];
}

function dedupeFiles(files) {
  const fileMap = new Map();
  for (const file of files) {
    fileMap.set(file.pathname, file);
  }
  return Array.from(fileMap.values());
}

function normalizeZipPath(value) {
  const parts = String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes(":"))) {
    return "";
  }
  return parts.join("/");
}

function isIgnoredEntry(pathname) {
  return pathname === ".DS_Store" || pathname.startsWith("__MACOSX/");
}

function throwZipError(message) {
  const zipError = new Error(message);
  zipError.status = 400;
  throw zipError;
}
