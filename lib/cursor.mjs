import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MIN_PAGE_LIMIT
} from "./constants.mjs";

const CURSOR_VERSION = 1;
const MAX_QUERY_LENGTH = 120;

function badRequest(message = "Invalid page cursor") {
  const error = new Error(message);
  error.status = 400;
  error.code = "invalid_cursor";
  return error;
}

function getCursorSecret() {
  return process.env.HTML_WORKBENCH_CURSOR_SECRET
    || process.env.HTML_WORKBENCH_AUTH_SECRET
    || process.env.HTML_WORKBENCH_PASSWORD
    || "html-workbench-cursor-secret";
}

function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
}

function assertCursorState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw badRequest();
  }
  if (state.version !== CURSOR_VERSION) {
    throw badRequest();
  }
  if (state.storageCursor !== null && typeof state.storageCursor !== "string") {
    throw badRequest();
  }
  if (typeof state.query !== "string" || typeof state.documentType !== "string") {
    throw badRequest();
  }
}

function signPayload(payload) {
  return createHmac("sha256", getCursorSecret()).update(payload).digest("base64url");
}

function assertSigned(prefix, payload, signature) {
  if (prefix !== `v${CURSOR_VERSION}` || !payload || !signature) {
    throw badRequest();
  }

  const expected = Buffer.from(signPayload(payload), "base64url");
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw badRequest();
  }
}

function asURL(value) {
  if (value instanceof URL) {
    return value;
  }
  try {
    return new URL(String(value), "http://localhost");
  } catch {
    throw badRequest("Invalid page request");
  }
}

export function normalizePageRequest(url) {
  const requestUrl = asURL(url);
  const params = requestUrl.searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null || rawLimit === "" ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
    const error = badRequest("Invalid page limit");
    error.code = "invalid_page_limit";
    throw error;
  }

  return {
    limit,
    cursor: params.get("cursor") || null,
    query: normalizeQuery(params.get("q")),
    documentType: String(params.get("documentType") || "").trim()
  };
}

export function encodePageCursor(state) {
  assertCursorState(state);
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `v${CURSOR_VERSION}.${payload}.${signPayload(payload)}`;
}

export function decodePageCursor(cursor, filters = {}) {
  const parts = String(cursor || "").split(".");
  if (parts.length !== 3) {
    throw badRequest();
  }
  const [prefix, payload, signature] = parts;
  assertSigned(prefix, payload, signature);

  let state;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw badRequest();
  }
  assertCursorState(state);
  if (state.query !== String(filters.query || "") || state.documentType !== String(filters.documentType || "")) {
    throw badRequest();
  }
  return state;
}
