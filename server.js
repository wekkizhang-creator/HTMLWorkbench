const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const { gzip } = require("node:zlib");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const START_PORT = Number(process.env.PORT || 3000);
const MAX_REQUEST_BODY_BYTES = 31 * 1024 * 1024;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

const gzipAsync = promisify(gzip);
const staticAssetCache = new Map();
const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".mjs", ".json", ".svg", ".txt"]);

loadLocalEnv();

const API_MODULES = {
  auth: pathToFileURL(path.join(ROOT_DIR, "api", "auth.mjs")).href,
  download: pathToFileURL(path.join(ROOT_DIR, "api", "download.mjs")).href,
  uploads: pathToFileURL(path.join(ROOT_DIR, "api", "uploads.mjs")).href,
  health: pathToFileURL(path.join(ROOT_DIR, "api", "health.mjs")).href,
  deleteUpload: pathToFileURL(path.join(ROOT_DIR, "api", "delete-upload.mjs")).href,
  view: pathToFileURL(path.join(ROOT_DIR, "api", "view.mjs")).href
};

function loadLocalEnv() {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(ROOT_DIR, fileName);
    let raw;
    try {
      raw = require("node:fs").readFileSync(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      continue;
    }

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const splitAt = trimmed.indexOf("=");
      if (splitAt === -1) {
        continue;
      }

      const key = trimmed.slice(0, splitAt).trim();
      let value = trimmed.slice(splitAt + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
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

function rejectUnauthorizedRequest(req, res) {
  req.pause();
  res.shouldKeepAlive = false;
  res.setHeader("Connection", "close");
  res.once("finish", () => {
    if (!req.destroyed) {
      req.destroy();
    }
  });
  sendError(res, 401, "Please enter the access password first");
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

function requestBodyTooLargeError() {
  const error = new Error("Request body exceeds the 31 MiB limit");
  error.status = 413;
  error.closeConnection = true;
  return error;
}

async function collectRequestBody(req) {
  const contentLength = req.headers["content-length"];
  if (
    contentLength !== undefined
    && /^\d+$/.test(String(contentLength))
    && Number(contentLength) > MAX_REQUEST_BODY_BYTES
  ) {
    req.pause();
    throw requestBodyTooLargeError();
  }

  return new Promise((resolve, reject) => {
    let chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onData = (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_REQUEST_BODY_BYTES) {
        chunks.push(chunk);
        return;
      }

      settled = true;
      chunks = [];
      cleanup();
      req.pause();
      reject(requestBodyTooLargeError());
    };
    const onEnd = () => {
      cleanup();
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks, totalBytes));
      }
    };
    const onError = (error) => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const onAborted = () => onError(new Error("Request body was aborted"));

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

async function toWebRequest(req, url) {
  const init = {
    headers: req.headers,
    method: req.method
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await collectRequestBody(req);
  }

  return new Request(url.href, init);
}

async function sendWebResponse(res, response) {
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.writeHead(response.status);

  if (
    !response.body
    || res.req?.method === "HEAD"
    || response.status === 204
    || response.status === 205
    || response.status === 304
  ) {
    res.end();
    return;
  }

  await pipeline(Readable.fromWeb(response.body), res);
}

async function callApiModule(moduleName, req, res, url) {
  const mod = await import(API_MODULES[moduleName]);
  const webRequest = await toWebRequest(req, url);
  const methodHandler = mod[req.method];
  const response = methodHandler
    ? await methodHandler(webRequest)
    : await mod.default.fetch(webRequest);
  await sendWebResponse(res, response);
}

async function isAuthorizedRequest(req) {
  const auth = await import(pathToFileURL(path.join(ROOT_DIR, "lib", "auth.mjs")).href);
  return auth.isAuthorizedCookie(req.headers.cookie || "");
}

function redirectToLogin(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const next = encodeURIComponent(`${url.pathname}${url.search}`);
  res.writeHead(302, {
    Location: `/login.html?next=${next}`,
    "Cache-Control": "no-store"
  });
  res.end();
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = safeResolve(PUBLIC_DIR, requestedPath);
  if (!filePath) {
    sendError(res, 403, "访问路径不合法");
    return;
  }

  try {
    const asset = await readStaticAsset(filePath);
    const representation = selectRepresentation(asset, req.headers["accept-encoding"]);
    if (!representation) {
      res.writeHead(406, {
        "Content-Length": "0",
        Vary: "Accept-Encoding"
      });
      res.end();
      return;
    }

    const headers = {
      "Content-Type": asset.contentType,
      "Cache-Control": asset.cacheControl,
      "Content-Length": String(representation.body.length),
      ETag: representation.etag,
      Vary: "Accept-Encoding"
    };
    if (representation.encoding) {
      headers["Content-Encoding"] = "gzip";
    }

    if (
      (req.method === "GET" || req.method === "HEAD")
      && matchesIfNoneMatch(req.headers["if-none-match"], representation.etag)
    ) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : representation.body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(res, 404, "页面不存在");
      return;
    }
    throw error;
  }
}

function parseQuality(value) {
  const normalized = value.trim();
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(normalized)) {
    return 0;
  }
  return Number(normalized);
}

function parseAcceptEncoding(header) {
  const qualities = new Map();
  if (!header || !String(header).trim()) {
    return qualities;
  }

  for (const entry of String(header).split(",")) {
    const [rawToken, ...parameters] = entry.split(";");
    const token = rawToken.trim().toLowerCase();
    if (!token) {
      continue;
    }

    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.match(/^\s*q\s*=\s*(.*?)\s*$/i);
      if (match) {
        quality = parseQuality(match[1]);
        break;
      }
    }
    qualities.set(token, Math.max(qualities.get(token) ?? 0, quality));
  }
  return qualities;
}

function selectRepresentation(asset, acceptEncoding) {
  const qualities = parseAcceptEncoding(acceptEncoding);
  const wildcardQuality = qualities.get("*");
  const identityQuality = qualities.has("identity")
    ? qualities.get("identity")
    : wildcardQuality === 0 ? 0 : 1;
  const gzipQuality = qualities.has("gzip")
    ? qualities.get("gzip")
    : wildcardQuality ?? 0;

  if (asset.gzipBody && gzipQuality > 0 && gzipQuality >= identityQuality) {
    return {
      body: asset.gzipBody,
      encoding: "gzip",
      etag: asset.gzipEtag
    };
  }
  if (identityQuality > 0) {
    return {
      body: asset.body,
      encoding: null,
      etag: asset.etag
    };
  }
  if (asset.gzipBody && gzipQuality > 0) {
    return {
      body: asset.gzipBody,
      encoding: "gzip",
      etag: asset.gzipEtag
    };
  }
  return null;
}

function matchesIfNoneMatch(header, etag) {
  if (!header) {
    return false;
  }

  const expected = etag.replace(/^W\//i, "");
  return String(header).split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized.replace(/^W\//i, "") === expected;
  });
}

async function readStaticAsset(filePath) {
  const stats = await fs.stat(filePath);
  const cached = staticAssetCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return cached;
  }

  const body = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  let gzipBody = null;
  if (COMPRESSIBLE_EXTENSIONS.has(extension) && body.length >= 1024) {
    try {
      gzipBody = await gzipAsync(body, { level: 6 });
    } catch (error) {
      console.warn(`Static compression failed for ${filePath}: ${error.message}`);
    }
  }

  const asset = {
    body,
    cacheControl: extension === ".html"
      ? "no-cache"
      : "public, max-age=600, stale-while-revalidate=86400",
    contentType: MIME_TYPES.get(extension) || "application/octet-stream",
    etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
    gzipBody,
    gzipEtag: gzipBody
      ? `"${createHash("sha256").update(gzipBody).digest("base64url")}"`
      : null,
    mtimeMs: stats.mtimeMs,
    size: stats.size
  };
  staticAssetCache.set(filePath, asset);
  return asset;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/healthz") {
    await callApiModule("health", req, res, url);
    return;
  }

  if (pathname === "/api/auth") {
    await callApiModule("auth", req, res, url);
    return;
  }

  if (pathname === "/api/download") {
    await callApiModule("download", req, res, url);
    return;
  }

  if ((pathname === "/" || pathname === "/index.html") && !(await isAuthorizedRequest(req))) {
    redirectToLogin(req, res);
    return;
  }

  if (pathname === "/api/uploads") {
    if (!(await isAuthorizedRequest(req))) {
      rejectUnauthorizedRequest(req, res);
      return;
    }
    await callApiModule("uploads", req, res, url);
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
  if (deleteMatch) {
    if (!(await isAuthorizedRequest(req))) {
      rejectUnauthorizedRequest(req, res);
      return;
    }
    url.pathname = "/api/delete-upload";
    url.searchParams.set("id", deleteMatch[1]);
    await callApiModule("deleteUpload", req, res, url);
    return;
  }

  const viewMatch = pathname.match(/^\/view\/([0-9a-f-]{36})(?:\/(.*))?$/i);
  if (viewMatch) {
    url.pathname = "/api/view";
    url.searchParams.set("id", viewMatch[1]);
    if (viewMatch[2]) {
      url.searchParams.set("path", viewMatch[2]);
    }
    await callApiModule("view", req, res, url);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res, pathname);
    return;
  }

  sendError(res, 405, "请求方法不支持");
}

function createAppServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        if (!res.destroyed) {
          res.destroy();
        }
        return;
      }
      if (error.closeConnection) {
        res.shouldKeepAlive = false;
        res.setHeader("Connection", "close");
        res.once("finish", () => {
          if (!req.destroyed) {
            req.destroy();
          }
        });
      }
      sendError(res, error.status || 500, error.status ? error.message : "服务器处理失败");
      if (!error.status) {
        console.error(error);
      }
    });
  });
}

async function start() {
  const server = createAppServer();

  const port = await listenWithFallback(server, START_PORT);
  console.log(`HTML 发布台已启动: http://localhost:${port}`);

  const shutdown = (signal) => {
    console.log(`收到 ${signal}，正在关闭 HTML 发布台...`);
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createAppServer, sendWebResponse };
