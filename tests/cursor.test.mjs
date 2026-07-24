import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePageCursor,
  encodePageCursor,
  normalizePageRequest
} from "../lib/cursor.mjs";

test("cursor round-trips and is bound to filters", () => {
  const state = {
    version: 1,
    storageCursor: "blob-next",
    query: "report",
    documentType: "analysis"
  };
  const cursor = encodePageCursor(state);

  assert.deepEqual(decodePageCursor(cursor, state), state);
  assert.throws(
    () => decodePageCursor(cursor, { query: "prototype", documentType: "analysis" }),
    (error) => error.status === 400
  );
});

test("page requests normalize filters and enforce the page limit", () => {
  assert.deepEqual(
    normalizePageRequest("https://example.test/api/uploads?limit=25&q=%20Report%20&documentType=%20Analysis%20"),
    { limit: 25, cursor: null, query: "report", documentType: "Analysis" }
  );
  assert.deepEqual(
    normalizePageRequest("https://example.test/api/uploads"),
    { limit: 50, cursor: null, query: "", documentType: "" }
  );
  assert.throws(
    () => normalizePageRequest("https://example.test/api/uploads?limit=101"),
    (error) => error.status === 400
  );
});

test("tampered cursors are rejected as bad requests", () => {
  const cursor = encodePageCursor({
    version: 1,
    storageCursor: null,
    query: "",
    documentType: ""
  });
  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;

  assert.throws(() => decodePageCursor(tampered, { query: "", documentType: "" }), (error) => error.status === 400);
});
