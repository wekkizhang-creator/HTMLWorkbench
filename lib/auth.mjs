import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "html_workbench_auth";
const DEFAULT_PASSWORD = "885688";

function getPassword() {
  return process.env.HTML_WORKBENCH_PASSWORD || DEFAULT_PASSWORD;
}

function getSecret() {
  return process.env.HTML_WORKBENCH_AUTH_SECRET || getPassword();
}

function getExpectedToken() {
  return createHash("sha256").update(`${getPassword()}:${getSecret()}`).digest("hex");
}

function parseCookies(cookieHeader = "") {
  const cookies = new Map();
  for (const item of cookieHeader.split(";")) {
    const splitAt = item.indexOf("=");
    if (splitAt === -1) continue;
    try {
      cookies.set(item.slice(0, splitAt).trim(), decodeURIComponent(item.slice(splitAt + 1).trim()));
    } catch {
      continue;
    }
  }
  return cookies;
}

export function safeEqual(input, expected) {
  const inputBuffer = Buffer.from(String(input || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return inputBuffer.length === expectedBuffer.length && timingSafeEqual(inputBuffer, expectedBuffer);
}

export function isAuthorizedCookie(cookieHeader = "") {
  const token = parseCookies(cookieHeader).get(AUTH_COOKIE_NAME);
  return Boolean(token) && safeEqual(token, getExpectedToken());
}

export function isAuthorizedRequest(request) {
  return isAuthorizedCookie(request.headers.get("cookie") || "");
}

export function verifyPassword(password) {
  return safeEqual(password, getPassword());
}

export function verifyDownloadPassword(password) {
  return safeEqual(password, process.env.HTML_WORKBENCH_DOWNLOAD_PASSWORD || DEFAULT_PASSWORD);
}

export function createAuthCookie({ secure = false } = {}) {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(getExpectedToken())}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearAuthCookie({ secure = false } = {}) {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}