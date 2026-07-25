import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SESSION_REVOCATION_PREFIX = "auth-revocations/v1/";
const EXPIRATION_WIDTH = 16;
const DEFAULT_CLEANUP_LIMIT = 100;

function normalizeSession(session) {
  const token = String(session?.token || "");
  const expiresAtMs = Number(session?.expiresAtMs);
  if (!token || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error("A valid session token and expiration are required for revocation");
  }
  return { token, expiresAtMs };
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function buildSessionRevocationPath(session) {
  const normalized = normalizeSession(session);
  const expiration = String(normalized.expiresAtMs).padStart(EXPIRATION_WIDTH, "0");
  return `${SESSION_REVOCATION_PREFIX}${expiration}-${tokenHash(normalized.token)}.json`;
}

function dataDirectory(options = {}) {
  return path.resolve(
    options.dataDir
      || process.env.HTML_WORKBENCH_DATA_DIR
      || path.join(process.cwd(), "data")
  );
}

function localPath(storagePath, options = {}) {
  return path.join(dataDirectory(options), ...storagePath.split("/"));
}

function usesBlob(options = {}) {
  return Boolean(options.blobSdk || process.env.BLOB_READ_WRITE_TOKEN);
}

async function blobSdk(options = {}) {
  return options.blobSdk || import("@vercel/blob");
}

function expirationFromPathname(pathname) {
  const fileName = String(pathname || "").slice(SESSION_REVOCATION_PREFIX.length);
  const match = fileName.match(/^(\d{16})-[a-f0-9]{64}\.json$/);
  return match ? Number(match[1]) : null;
}

export async function revokeSession(session, options = {}) {
  const normalized = normalizeSession(session);
  const storagePath = buildSessionRevocationPath(normalized);
  const body = `${JSON.stringify({
    version: 1,
    expiresAt: new Date(normalized.expiresAtMs).toISOString(),
    revokedAt: new Date(options.nowMs ?? Date.now()).toISOString()
  })}\n`;

  if (usesBlob(options)) {
    const { put } = await blobSdk(options);
    await put(storagePath, body, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8"
    });
    return storagePath;
  }

  const target = localPath(storagePath, options);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let handle;
  try {
    handle = await fs.open(target, "wx", 0o640);
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  return storagePath;
}

export async function isSessionRevoked(session, options = {}) {
  const storagePath = buildSessionRevocationPath(session);
  if (usesBlob(options)) {
    const { get } = await blobSdk(options);
    const result = await get(storagePath, { access: "private", useCache: false });
    return Boolean(result && result.statusCode === 200);
  }

  try {
    await fs.access(localPath(storagePath, options));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function cleanupExpiredSessionRevocations(options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxDeletes = Math.max(
    1,
    Math.min(1000, Number(options.maxDeletes || DEFAULT_CLEANUP_LIMIT))
  );

  if (usesBlob(options)) {
    const { del, list } = await blobSdk(options);
    const result = await list({
      prefix: SESSION_REVOCATION_PREFIX,
      limit: maxDeletes
    });
    const expired = [];
    for (const blob of result.blobs || []) {
      const expiration = expirationFromPathname(blob.pathname);
      if (expiration === null || expiration > nowMs) break;
      expired.push(blob.pathname);
    }
    if (expired.length) await del(expired);
    return expired.length;
  }

  const directory = localPath(SESSION_REVOCATION_PREFIX, options);
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
  const expired = entries
    .map((name) => `${SESSION_REVOCATION_PREFIX}${name}`)
    .sort()
    .filter((pathname) => {
      const expiration = expirationFromPathname(pathname);
      return expiration !== null && expiration <= nowMs;
    })
    .slice(0, maxDeletes);
  await Promise.all(expired.map((pathname) => fs.rm(localPath(pathname, options), { force: true })));
  return expired.length;
}
