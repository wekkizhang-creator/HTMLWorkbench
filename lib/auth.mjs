import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getRuntimeConfig } from "./runtime.mjs";

export const AUTH_COOKIE_NAME = "html_workbench_auth";
export const CSRF_HEADER_NAME = "x-csrf-token";
const DEFAULT_PASSWORD = "885688";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function getPassword() {
  return process.env.HTML_WORKBENCH_PASSWORD || DEFAULT_PASSWORD;
}

function getSecret() {
  return process.env.HTML_WORKBENCH_AUTH_SECRET || getPassword();
}

function signSessionPayload(payload) {
  return createHmac("sha256", `${getPassword()}:${getSecret()}`)
    .update(payload)
    .digest("base64url");
}

function createSessionToken() {
  const issuedAt = Math.floor(Date.now() / 1000).toString(36);
  const payload = `${issuedAt}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${signSessionPayload(payload)}`;
}

function isValidSessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  const [issuedAt, nonce, signature] = parts;
  if (!/^[0-9a-z]+$/i.test(issuedAt) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const issuedAtSeconds = Number.parseInt(issuedAt, 36);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(issuedAtSeconds)
    || issuedAtSeconds > nowSeconds + 300
    || nowSeconds - issuedAtSeconds > SESSION_MAX_AGE_SECONDS
  ) return false;
  return safeEqual(signature, signSessionPayload(`${issuedAt}.${nonce}`));
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
  return isValidSessionToken(token);
}

function getAuthorizedSessionToken(cookieHeader = "") {
  const token = parseCookies(cookieHeader).get(AUTH_COOKIE_NAME);
  return isValidSessionToken(token) ? token : null;
}

export function createCsrfToken(cookieHeader = "") {
  const sessionToken = getAuthorizedSessionToken(cookieHeader);
  if (!sessionToken) return null;
  return createHmac("sha256", getSecret())
    .update(`html-workbench-csrf:${sessionToken}`)
    .digest("base64url");
}

export function isAdminHostRequest(request) {
  const requestHost = new URL(request.url).host.toLowerCase();
  return requestHost === new URL(getRuntimeConfig().adminOrigin).host.toLowerCase();
}

export function managementRequestFailure(request, { requireAuth = true, requireCsrf = true } = {}) {
  if (!isAdminHostRequest(request)) {
    return { message: "Page does not exist", status: 404 };
  }
  if (request.headers.get("origin") !== getRuntimeConfig().adminOrigin) {
    return { message: "Management requests must come from the admin origin", status: 403 };
  }
  if (requireAuth && !isAuthorizedRequest(request)) {
    return { message: "Please enter the access password first", status: 401 };
  }
  if (requireCsrf) {
    const expected = createCsrfToken(request.headers.get("cookie") || "");
    const provided = request.headers.get(CSRF_HEADER_NAME);
    if (!expected || !provided || !safeEqual(provided, expected)) {
      return { message: "CSRF token is missing or invalid", status: 403 };
    }
  }
  return null;
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
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(createSessionToken())}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearAuthCookie({ secure = false } = {}) {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}