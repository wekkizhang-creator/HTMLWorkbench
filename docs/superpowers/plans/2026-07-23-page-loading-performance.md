# Page Loading Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the management page's initial transfer size and request latency while showing immediate, accessible loading feedback for records, refreshes, and uploads.

**Architecture:** Keep the existing framework-free browser app and Node/Vercel API layout. Optimize self-hosted static delivery inside `server.js`, reduce the existing Logo in place, and centralize browser loading state in `public/app.js` without changing persisted records or API response shapes.

**Tech Stack:** Node.js 20+, CommonJS HTTP server, browser JavaScript, CSS, Node built-in test runner, PowerShell image resize tooling.

## Global Constraints

- Preserve upload, replace, rollback, download, search, filtering, and authentication behavior.
- Keep Vercel and self-hosted deployments compatible.
- Do not add a frontend framework, bundler, Service Worker, or runtime image dependency.
- Keep first-screen static transfer below 100 KB and `public/brand-logo.png` below 60 KB.
- Loading feedback must be regional, accessible, responsive, and must not block the whole page.
- Do not change the storage model, Vercel Blob record format, business fields, or permission rules.

---

### Task 1: Cache and compress self-hosted static responses

**Files:**
- Create: `tests/server-static.test.mjs`
- Modify: `server.js:1-293`
- Modify: `package.json:6-10`

**Interfaces:**
- Produces: `createAppServer(): http.Server`, exported from `server.js` for future in-process tests.
- Produces: static responses with `ETag`, `Cache-Control`, optional `Content-Encoding: gzip`, and `Vary: Accept-Encoding`.
- Preserves: `node server.js` startup and all existing route behavior.

- [ ] **Step 1: Write the failing static-response tests**

Create `tests/server-static.test.mjs` with a helper that reserves an ephemeral port, starts the current `server.js` in a child process, and always stops it after each test. The child-process boundary ensures the test can fail safely before `server.js` is refactored to avoid startup on import:

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withServer(run) {
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTML_WORKBENCH_DATA_DIR: `${process.cwd()}/data-test`,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server startup timed out")), 5000);
    child.once("exit", (code) => reject(new Error(`server exited with code ${code}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("已启动")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

test("static text assets support gzip and conditional requests", async () => {
  await withServer(async (origin) => {
    const first = await fetch(`${origin}/styles.css`, {
      headers: { "Accept-Encoding": "gzip" }
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-encoding"), "gzip");
    assert.match(first.headers.get("cache-control") || "", /max-age=/);
    assert.equal(first.headers.get("vary"), "Accept-Encoding");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    assert.match(await first.text(), /:root/);

    const cached = await fetch(`${origin}/styles.css`, {
      headers: { "If-None-Match": etag }
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
  });
});

test("HEAD returns static headers without a response body", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/app.js`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("etag"));
    assert.equal(await response.text(), "");
  });
});
```

- [ ] **Step 2: Run the test and verify that it fails**

Run: `node --test tests/server-static.test.mjs`

Expected: FAIL on the missing Gzip, ETag, or cache headers while the child process is still cleaned up.

- [ ] **Step 3: Refactor server construction without changing startup behavior**

In `server.js`, move the existing `http.createServer(...)` block into:

```js
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
```

Use `const server = createAppServer();` in `start()`, and replace the unconditional final startup with:

```js
if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createAppServer };
```

- [ ] **Step 4: Add an mtime-aware static cache, ETag, Gzip, and HEAD handling**

Use Node built-ins only. Add `createHash`, `promisify`, and `gzip`, then introduce:

```js
const gzipAsync = promisify(gzip);
const staticAssetCache = new Map();
const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".svg", ".txt"]);

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
```

Update `serveStatic()` to return `304` when `If-None-Match` matches, select the Gzip body only when the request accepts it, set `Content-Length`, and end without a body for `HEAD`. Preserve the existing `403`, `404`, and MIME behavior.

- [ ] **Step 5: Add the test command and verify the task**

Update `package.json` scripts to include:

```json
"test": "node --test",
"check": "node scripts/check.mjs && node --test"
```

Run: `npm.cmd run check`

Expected: syntax checks and both static-response tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add server.js package.json tests/server-static.test.mjs
git commit -m "Optimize static asset delivery"
```

---

### Task 2: Reduce the Logo transfer size

**Files:**
- Modify: `public/brand-logo.png`
- Modify: `scripts/check.mjs:1-25`

**Interfaces:**
- Preserves: `/brand-logo.png` URL, PNG MIME type, page markup, and visual identity.
- Produces: a 128x128 PNG no larger than 60 KB.

- [ ] **Step 1: Add a failing Logo size guard**

Add `statSync` to `scripts/check.mjs` and append:

```js
const MAX_BRAND_LOGO_BYTES = 60 * 1024;
const logoSize = statSync("public/brand-logo.png").size;
if (logoSize > MAX_BRAND_LOGO_BYTES) {
  console.error(`public/brand-logo.png is ${logoSize} bytes; limit is ${MAX_BRAND_LOGO_BYTES}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run the guard and verify that it fails**

Run: `npm.cmd run check`

Expected: FAIL reporting the current 889,031-byte Logo above the 61,440-byte limit.

- [ ] **Step 3: Resize the existing Logo deterministically**

Use `System.Drawing` to render the existing image into a 128x128 high-quality bitmap, write to a temporary file beside the target, dispose all graphics resources, and atomically replace `public/brand-logo.png`. Keep the composition and colors unchanged; this is a resize, not a redesign.

- [ ] **Step 4: Verify dimensions, size, and checks**

Run a PowerShell image inspection and `npm.cmd run check`.

Expected: dimensions are `128 x 128`, size is below 60 KB, and all checks PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add public/brand-logo.png scripts/check.mjs
git commit -m "Reduce brand logo transfer size"
```

---

### Task 3: Add loading states and remove the redundant auth request

**Files:**
- Create: `tests/ui-loading.test.mjs`
- Modify: `public/index.html:30-166`
- Modify: `public/app.js:1-598`
- Modify: `public/styles.css:80-510`

**Interfaces:**
- Produces: `setRecordsLoading(isLoading)`, `showRecordsLoadError(message)`, and `setUploadLoading(isLoading)` browser helpers.
- Consumes: the existing `/api/uploads` contract and existing `api()` redirect-on-401 behavior.
- Preserves: login, filter, upload, replace, rollback, delete, and refresh behavior.

- [ ] **Step 1: Write the failing UI contract test**

Create `tests/ui-loading.test.mjs`:

```js
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
});
```

- [ ] **Step 2: Run the test and verify that it fails**

Run: `node --test tests/ui-loading.test.mjs`

Expected: FAIL because the loading/error elements and helpers do not exist.

- [ ] **Step 3: Add stable loading and error markup**

Give the records panel `id="recordsPanel"` and initial `aria-busy="true"`. Inside `.table-frame`, before the empty state, add:

```html
<div class="records-loading" id="recordsLoading" role="status">
  <span class="loading-spinner" aria-hidden="true"></span>
  <span>正在读取上传记录</span>
  <span class="loading-lines" aria-hidden="true"><i></i><i></i><i></i></span>
</div>
<div class="records-error" id="recordsError" hidden>
  <strong>记录加载失败</strong>
  <span id="recordsErrorMessage">请检查网络后重试</span>
  <button class="button secondary" id="retryButton" type="button">重新加载</button>
</div>
```

Wrap the upload button label in `<span id="uploadButtonLabel">发布</span>` so its text can change without rebuilding SVG markup.

- [ ] **Step 4: Implement centralized browser loading state**

Add the new elements to `elements`, add `hasLoadedRecords` and `recordsLoading` to `state`, then implement:

```js
function setRecordsLoading(isLoading) {
  state.recordsLoading = isLoading;
  elements.recordsPanel.setAttribute("aria-busy", String(isLoading));
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.classList.toggle("is-loading", isLoading);
  elements.recordsLoading.hidden = !(isLoading && !state.hasLoadedRecords);
  if (isLoading) {
    elements.recordsError.hidden = true;
  }
}

function showRecordsLoadError(message) {
  if (state.hasLoadedRecords) {
    showToast(message);
    return;
  }
  elements.recordsLoading.hidden = true;
  elements.recordsError.hidden = false;
  elements.recordsErrorMessage.textContent = message || "请检查网络后重试";
}

function setUploadLoading(isLoading) {
  elements.uploadForm.setAttribute("aria-busy", String(isLoading));
  elements.uploadButton.classList.toggle("is-loading", isLoading);
  elements.uploadButtonLabel.textContent = isLoading ? "正在发布" : "发布";
  elements.uploadStatus.textContent = isLoading ? "发布中" : state.selectedFile ? "已选择" : "待选择";
}
```

Make `loadRecords()` own its `try/catch/finally`, retain already-rendered rows during refresh failures, and wire `retryButton` to `loadRecords()`. Remove `ensureAuthenticated()` and initialize with `loadRecords()` directly; `api()` already redirects on `401`.

Update `uploadSelectedFile()` to call `setUploadLoading(true)` before the request and `setUploadLoading(false)` in `finally`, without assigning `innerHTML` to the button.

- [ ] **Step 5: Add loading styles without layout shift**

Create one reusable spinner animation and fixed-height records states:

```css
.loading-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: loading-spin 760ms linear infinite;
}

@keyframes loading-spin {
  to { transform: rotate(360deg); }
}

.records-loading,
.records-error {
  min-height: 180px;
  align-content: center;
  justify-items: center;
}

.icon-button.is-loading svg {
  animation: loading-spin 760ms linear infinite;
}
```

Use opacity pulsing for the three loading lines, preserve the existing 8px radius system, and add mobile rules so the states remain within the viewport.

- [ ] **Step 6: Run checks and commit Task 3**

Run: `npm.cmd run check`

Expected: syntax checks, static-response tests, Logo guard, and UI contract tests PASS.

```bash
git add public/index.html public/app.js public/styles.css tests/ui-loading.test.mjs
git commit -m "Add responsive page loading states"
```

---

### Task 4: Verify performance and responsive behavior

**Files:**
- Modify only if verification exposes a defect in Task 1-3 files.

**Interfaces:**
- Verifies all outputs from Tasks 1-3; produces no new runtime API.

- [ ] **Step 1: Run the complete automated checks**

Run: `npm.cmd run check`

Expected: all syntax, HTTP, resource-size, and UI contract checks PASS.

- [ ] **Step 2: Start the local server and capture HTTP evidence**

Run the app with a temporary `HTML_WORKBENCH_DATA_DIR`, then request `/styles.css` with Gzip and ETag headers.

Expected:

- `200` with `Content-Encoding: gzip`, `ETag`, and cache headers.
- Revalidation with `If-None-Match` returns `304`.
- `/brand-logo.png` transfers less than 60 KB.
- `/` still redirects unauthenticated users to `/login.html?next=%2F`.

- [ ] **Step 3: Verify browser states at desktop and mobile widths**

Open the management page at approximately 1440x900 and 390x844. Capture the first-load state and loaded state.

Expected: loading content appears immediately, table geometry does not jump incoherently, controls do not overlap, refresh visibly spins, upload shows `正在发布`, and error/retry state fits the viewport.

- [ ] **Step 4: Compare transfer and request counts**

Record the optimized Logo size and the management startup API sequence.

Expected: initial code invokes `/api/uploads` directly with no preceding `/api/auth`; first-screen static transfer is below 100 KB; repeat static requests can use cache or `304`.

- [ ] **Step 5: Review the final diff and commit any verification-only fixes**

Run:

```bash
git diff --check
git status --short
```

If verification required corrections, commit only those corrections with:

```bash
git add server.js public/index.html public/app.js public/styles.css public/brand-logo.png scripts/check.mjs tests
git commit -m "Polish page loading performance"
```
