import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("records UI ships an immediate loading and retry state", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.match(html, /id="recordsPanel"[^>]*aria-busy="true"/);
  assert.match(html, /id="recordsLoading"/);
  assert.match(html, /id="recordsError"/);
  assert.match(html, /id="retryButton"/);
});

test("app loads records directly and centralizes loading state", async () => {
  const app = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");
  assert.doesNotMatch(app, /ensureAuthenticated/);
  assert.match(app, /function setRecordsLoading\(/);
  assert.match(app, /function setUploadLoading\(/);
  assert.match(css, /@keyframes loading-spin/);
  assert.match(css, /\.records-loading/);
  assert.match(css, /\.records-loading\[hidden\],\s*\.records-error\[hidden\]\s*\{\s*display:\s*none;/s);
});
