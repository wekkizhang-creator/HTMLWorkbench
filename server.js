const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { promisify } = require("node:util");
const { gzip } = require("node:zlib");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const START_PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

const gzipAsync = promisify(gzip);
const staticAssetCache = new Map();
const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg", ".txt"]);

loadLocalEnv();

const API_MODULES = {
  auth: pathToFileURL(path.join(ROOT_DIR, "api", "auth.mjs")).href,
  download: pathToFileURL(path.join(ROOT_DIR, "api", "download.mjs")).href,
  uploads: pathToFileURL(path.join(ROOT_DIR, "api", "uploads.mjs")).href,
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

async function collectRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

  if (!response.body) {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
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
    if (req.headers["if-none-match"] === asset.etag) {
      res.writeHead(304, {
        ETag: asset.etag,
        "Cache-Control": asset.cacheControl,
        Vary: "Accept-Encoding"
      });
      res.end();
      return;
    }

    const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers["accept-encoding"] || "");
    const body = acceptsGzip && asset.gzipBody ? asset.gzipBody : asset.body;
    const headers = {
      "Content-Type": asset.contentType,
      "Cache-Control": asset.cacheControl,
      "Content-Length": String(body.length),
      ETag: asset.etag,
      Vary: "Accept-Encoding"
    };
    if (body === asset.gzipBody) {
      headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(res, 404, "页面不存在");
      return;
    }
    throw error;
  }
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
    mtimeMs: stats.mtimeMs,
    size: stats.size
  };
  staticAssetCache.set(filePath, asset);
  return asset;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

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
    await callApiModule("uploads", req, res, url);
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
  if (deleteMatch) {
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

module.exports = { createAppServer };
