const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RECORDS_FILE = path.join(DATA_DIR, "records.json");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const START_PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

async function ensureStore() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(RECORDS_FILE);
  } catch {
    await fs.writeFile(RECORDS_FILE, "[]\n", "utf8");
  }
}

async function readRecords() {
  await ensureStore();
  const raw = await fs.readFile(RECORDS_FILE, "utf8");
  const records = JSON.parse(raw);
  return Array.isArray(records) ? records : [];
}

async function writeRecords(records) {
  await ensureStore();
  const tempFile = `${RECORDS_FILE}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, RECORDS_FILE);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function safeResolve(baseDir, urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const resolved = path.resolve(baseDir, `.${decodedPath}`);
  const relative = path.relative(baseDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = safeResolve(PUBLIC_DIR, requestedPath);
  if (!filePath) {
    sendError(res, 403, "访问路径不合法");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(res, 404, "页面不存在");
      return;
    }
    throw error;
  }
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]).trim() : "";
}

function parseHeaderParams(headerValue) {
  const params = new Map();
  const pattern = /;\s*([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(headerValue)) !== null) {
    params.set(match[1].toLowerCase(), match[2]);
  }
  return params;
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const doubleBreak = Buffer.from("\r\n\r\n");
  const lineBreak = Buffer.from("\r\n");
  const parts = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuffer, cursor);
    if (boundaryStart === -1) {
      break;
    }

    let partStart = boundaryStart + boundaryBuffer.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") {
      break;
    }
    if (buffer.slice(partStart, partStart + 2).equals(lineBreak)) {
      partStart += 2;
    }

    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundary === -1) {
      break;
    }

    let partEnd = nextBoundary;
    if (buffer.slice(partEnd - 2, partEnd).equals(lineBreak)) {
      partEnd -= 2;
    }

    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf(doubleBreak);
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + doubleBreak.length);
      const headers = new Map();
      for (const line of headerText.split("\r\n")) {
        const splitAt = line.indexOf(":");
        if (splitAt !== -1) {
          headers.set(line.slice(0, splitAt).toLowerCase(), line.slice(splitAt + 1).trim());
        }
      }
      parts.push({ headers, body });
    }

    cursor = nextBoundary;
  }

  return parts;
}

async function collectRequestBody(req) {
  const chunks = [];
  let received = 0;

  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      const error = new Error("文件超过 10 MB 限制");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function getUploadedHtml(parts) {
  for (const part of parts) {
    const disposition = part.headers.get("content-disposition") || "";
    const params = parseHeaderParams(disposition);
    const filename = params.get("filename");
    if (!filename) {
      continue;
    }

    const safeName = path.basename(filename.replace(/\\/g, "/")).trim();
    const extension = path.extname(safeName).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") {
      const error = new Error("只能上传 .html 或 .htm 文件");
      error.statusCode = 415;
      throw error;
    }
    if (part.body.length === 0) {
      const error = new Error("上传的 HTML 文件为空");
      error.statusCode = 400;
      throw error;
    }

    return {
      filename: safeName || "untitled.html",
      body: part.body
    };
  }

  const error = new Error("没有找到 HTML 文件");
  error.statusCode = 400;
  throw error;
}

function extractTitle(fileBuffer, fallback) {
  const sample = fileBuffer.slice(0, 120 * 1024).toString("utf8");
  const match = sample.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return fallback;
  }
  return match[1].replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

async function handleUpload(req, res) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    sendError(res, 415, "请使用表单上传 HTML 文件");
    return;
  }

  const boundary = getBoundary(contentType);
  if (!boundary) {
    sendError(res, 400, "上传请求缺少 boundary");
    return;
  }

  const requestBody = await collectRequestBody(req);
  const parts = parseMultipart(requestBody, boundary);
  const upload = getUploadedHtml(parts);
  const id = crypto.randomUUID();
  const storedName = `${id}.html`;
  const uploadPath = path.join(UPLOAD_DIR, storedName);
  await fs.writeFile(uploadPath, upload.body);

  const records = await readRecords();
  const record = {
    id,
    originalName: upload.filename,
    title: extractTitle(upload.body, upload.filename),
    size: upload.body.length,
    url: `/view/${id}`,
    uploadedAt: new Date().toISOString()
  };

  await writeRecords([record, ...records]);
  sendJson(res, 201, { record });
}

async function handleListUploads(_req, res) {
  const records = await readRecords();
  sendJson(res, 200, { records });
}

async function handleDeleteUpload(res, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    sendError(res, 400, "记录 ID 不合法");
    return;
  }

  const records = await readRecords();
  const record = records.find((item) => item.id === id);
  if (!record) {
    sendError(res, 404, "上传记录不存在");
    return;
  }

  await fs.unlink(path.join(UPLOAD_DIR, `${record.id}.html`)).catch((error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
  await writeRecords(records.filter((item) => item.id !== id));
  sendJson(res, 200, { ok: true });
}

async function handleViewUpload(res, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    sendError(res, 400, "访问链接不合法");
    return;
  }

  const records = await readRecords();
  const record = records.find((item) => item.id === id);
  if (!record) {
    sendError(res, 404, "HTML 页面不存在");
    return;
  }

  try {
    const file = await fs.readFile(path.join(UPLOAD_DIR, `${record.id}.html`));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(res, 404, "HTML 文件已丢失");
      return;
    }
    throw error;
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/uploads") {
    await handleListUploads(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/uploads") {
    await handleUpload(req, res);
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
  if (req.method === "DELETE" && deleteMatch) {
    await handleDeleteUpload(res, deleteMatch[1]);
    return;
  }

  const viewMatch = pathname.match(/^\/view\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && viewMatch) {
    await handleViewUpload(res, viewMatch[1]);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, pathname);
    return;
  }

  sendError(res, 405, "请求方法不支持");
}

async function start() {
  await ensureStore();
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      const statusCode = error.statusCode || 500;
      sendError(res, statusCode, statusCode === 500 ? "服务器处理失败" : error.message);
      if (statusCode === 500) {
        console.error(error);
      }
    });
  });

  const port = await listenWithFallback(server, START_PORT);
  console.log(`HTML 发布台已启动: http://localhost:${port}`);
}

function listenWithFallback(server, startPort) {
  const maxPort = startPort + 20;

  return new Promise((resolve, reject) => {
    const tryListen = (port) => {
      if (port > maxPort) {
        reject(new Error(`端口 ${startPort}-${maxPort} 都不可用`));
        return;
      }

      const onError = (error) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE") {
          tryListen(port + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(port);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port);
    };

    tryListen(startPort);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
