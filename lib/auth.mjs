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
    if (splitAt === -1) {
      continue;
    }
    cookies.set(item.slice(0, splitAt).trim(), decodeURIComponent(item.slice(splitAt + 1).trim()));
  }
  return cookies;
}

export function isAuthorizedCookie(cookieHeader = "") {
  const token = parseCookies(cookieHeader).get(AUTH_COOKIE_NAME);
  if (!token) {
    return false;
  }

  const expected = getExpectedToken();
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (tokenBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(tokenBuffer, expectedBuffer);
}

export function isAuthorizedRequest(request) {
  return isAuthorizedCookie(request.headers.get("cookie") || "");
}

export function verifyPassword(password) {
  const inputBuffer = Buffer.from(String(password || ""));
  const expectedBuffer = Buffer.from(getPassword());
  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(inputBuffer, expectedBuffer);
}

export function createAuthCookie() {
  const token = encodeURIComponent(getExpectedToken());
  return `${AUTH_COOKIE_NAME}=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
}

export function clearAuthCookie() {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
