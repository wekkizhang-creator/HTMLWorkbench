# HTMLWorkbench Public Origin, Pagination, and Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve uploaded sites from `page.wekki.fun`, paginate all upload records beyond 1000 Blob objects, and add state-driven page and upload animations.

**Architecture:** Run role-restricted admin and content Node processes against shared storage. Keep canonical records under `records/`, add a reverse-timestamp Blob index for stable newest-first pagination, and expose signed opaque cursors to the admin client. Render the download password form from an admin-origin iframe and drive UI motion from real request states.

**Tech Stack:** Node.js 20+, native HTTP server, Web Fetch APIs, `@vercel/blob`, vanilla JavaScript/CSS, Node test runner, systemd, Nginx, Docker Compose.

## Global Constraints

- Admin origin is exactly `https://ho.wekki.fun`.
- Public origin is exactly `https://page.wekki.fun`.
- Admin process listens on `127.0.0.1:3000`; content process listens on `127.0.0.1:3001`.
- Public content must not expose login, upload-management APIs, admin static files, or download secrets.
- Existing record IDs, `/view/:id` paths, HTML uploads, ZIP sites, replacement, rollback, deletion, and download remain compatible.
- List page size defaults to 50 and accepts values from 1 through 100.
- Cursor values are opaque, signed, versioned, and bound to search and document-type filters.
- Search covers title, description, original filename, and document type across all indexed records.
- Upload progress must use real transferred bytes; server processing uses an indeterminate state after transfer completes.
- Motion must preserve layout dimensions and honor `prefers-reduced-motion: reduce`.
- New behavior follows red-green-refactor TDD and the complete `npm.cmd run check` suite must pass before release.

## File Structure

- Create `lib/runtime.mjs`: normalize roles/origins, build public URLs, validate Hosts, and expose role route policy.
- Create `lib/cursor.mjs`: normalize page queries and sign/verify opaque pagination cursors.
- Create `lib/record-index.mjs`: build index keys/documents and match search/filter criteria.
- Create `api/download-widget.mjs`: trusted admin-origin iframe document.
- Create `scripts/migrate-record-index.mjs`: idempotent record-index backfill and repair command.
- Create `deploy/self-host/html-workbench-content.service`: read-only content process.
- Create `tests/runtime-routing.test.mjs`: role, Host, redirect, and public-route isolation tests.
- Create `tests/cursor.test.mjs`: cursor signing and query validation tests.
- Create `tests/record-pagination.test.mjs`: ordered index, pagination, filtering, and migration tests.
- Modify `server.js`: bind to configured Host, enforce role route tables, redirect legacy view links, and expose the download widget route.
- Modify `lib/auth.mjs`: separate download password and production cookie attributes.
- Modify `lib/records.mjs`: derive public URLs from configured public origin.
- Modify `lib/storage.mjs`: maintain and page the ordered index for Blob and local storage.
- Modify `api/uploads.mjs`: accept page query fields and return page metadata.
- Modify `api/delete-upload.mjs`: maintain the ordered index during replace, rollback, and delete.
- Modify `api/view.mjs`: inject public base paths and a cross-origin iframe instead of a password form.
- Modify `api/download.mjs`: use the download password and validate admin-origin requests.
- Modify `public/app.js`: use server pagination, request cancellation, XHR upload progress, and state-driven row animations.
- Modify `public/index.html`: add accessible progress and loading status elements.
- Modify `public/styles.css`: add skeleton, progress, append, success, and reduced-motion styles.
- Modify `deploy/self-host/html-workbench.service`: configure the admin role and loopback binding.
- Modify `deploy/self-host/nginx.conf`: add separate admin/content server blocks.
- Modify `deploy/self-host/deploy.sh`: install both services, run migration, restart both processes, and verify both health endpoints.
- Modify `deploy/self-host/html-workbench.env.example`, `docker-compose.yml`, `Dockerfile`, `README.md`, and `package.json`: document and run the two-role deployment and migration.

---

### Task 1: Runtime Roles, Origins, and Host Routing

**Files:**
- Create: `lib/runtime.mjs`
- Create: `tests/runtime-routing.test.mjs`
- Modify: `server.js`
- Modify: `lib/records.mjs`
- Modify: `tests/server-static.test.mjs`
- Modify: `tests/server-io.test.mjs`

**Interfaces:**
- Produces: `getRuntimeConfig()`, `buildPublicViewUrl(record)`, `isAllowedHost(host, role)`, and `isRouteAllowed(role, pathname)`.
- Consumes: `HTML_WORKBENCH_ROLE`, `HTML_WORKBENCH_ADMIN_ORIGIN`, `HTML_WORKBENCH_PUBLIC_ORIGIN`, `HOST`, and `PORT`.
- Later tasks use `getRuntimeConfig()` for Origin checks and iframe URLs.

- [ ] **Step 1: Write failing runtime and route-isolation tests**

```js
const TEST_RECORD_ID = "11111111-1111-4111-8111-111111111111";

test("public records use the configured public origin", async () => {
  await withEnv({ HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun" }, async () => {
    const { publicRecord } = await importFresh("../lib/records.mjs");
    assert.equal(
      publicRecord({ id: TEST_RECORD_ID, url: `/view/${TEST_RECORD_ID}` }).url,
      `https://page.wekki.fun/view/${TEST_RECORD_ID}`
    );
  });
});

test("content role exposes view routes but rejects admin APIs", async () => {
  const server = await startServer({
    HTML_WORKBENCH_ROLE: "content",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  });
  assert.equal((await request(server, "/api/uploads", { host: "page.wekki.fun" })).status, 404);
  assert.equal((await request(server, `/view/${TEST_RECORD_ID}`, { host: "page.wekki.fun" })).status, 200);
});

test("admin role redirects legacy view paths without losing suffix or query", async () => {
  const response = await request(adminServer, `/view/${TEST_RECORD_ID}/assets/app.js?v=2`, {
    host: "ho.wekki.fun"
  });
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.location,
    `https://page.wekki.fun/view/${TEST_RECORD_ID}/assets/app.js?v=2`
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/runtime-routing.test.mjs tests/server-static.test.mjs tests/server-io.test.mjs
```

Expected: failures because `lib/runtime.mjs`, role-based routing, absolute public URLs, and the legacy redirect do not exist.

- [ ] **Step 3: Implement runtime configuration and URL derivation**

```js
const VALID_ROLES = new Set(["admin", "content"]);

export function getRuntimeConfig() {
  const role = process.env.HTML_WORKBENCH_ROLE || "admin";
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Unsupported HTML_WORKBENCH_ROLE: ${role}`);
  }
  return {
    role,
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || (role === "content" ? 3001 : 3000)),
    adminOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_ADMIN_ORIGIN || "http://localhost:3000"),
    publicOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_PUBLIC_ORIGIN || "http://localhost:3001")
  };
}

export function buildPublicViewUrl(record) {
  return new URL(record.url || `/view/${record.id}`, getRuntimeConfig().publicOrigin).href;
}
```

Update `publicRecord()` to return `buildPublicViewUrl(record)`. In `server.js`, create role-specific routing before static-file handling, return `421` for an unexpected Host, return `404` for denied content-role paths, and redirect admin `/view/*` requests with status `307`. Change `listenWithFallback()` to call `server.listen(port, host)`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/runtime-routing.test.mjs tests/server-static.test.mjs tests/server-io.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the runtime boundary**

```powershell
git add lib/runtime.mjs lib/records.mjs server.js tests/runtime-routing.test.mjs tests/server-static.test.mjs tests/server-io.test.mjs
git commit -m "Add admin and public runtime boundaries"
```

### Task 2: Cross-Origin Download Widget and Separate Password

**Files:**
- Create: `api/download-widget.mjs`
- Create: `tests/download-isolation.test.mjs`
- Modify: `api/view.mjs`
- Modify: `api/download.mjs`
- Modify: `lib/auth.mjs`
- Modify: `server.js`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `getRuntimeConfig()` from Task 1.
- Produces: `verifyDownloadPassword(password)`, `isTrustedAdminOrigin(request)`, and `GET /public-download-widget/:id`.
- `api/view.mjs` injects only an iframe whose `src` points to the admin origin.

- [ ] **Step 1: Write failing download-isolation tests**

```js
const TEST_RECORD_ID = "11111111-1111-4111-8111-111111111111";

test("view HTML contains an admin-origin iframe and no password input", async () => {
  const response = await viewGet(viewRequest(TEST_RECORD_ID));
  const html = await response.text();
  assert.match(html, /https:\/\/ho\.wekki\.fun\/public-download-widget\//);
  assert.doesNotMatch(html, /html-workbench-download-password/);
  assert.doesNotMatch(html, /type="password"/);
});

test("download uses a dedicated password", async () => {
  await withEnv({
    HTML_WORKBENCH_PASSWORD: "admin-secret",
    HTML_WORKBENCH_DOWNLOAD_PASSWORD: "885688"
  }, async () => {
    assert.equal(verifyDownloadPassword("admin-secret"), false);
    assert.equal(verifyDownloadPassword("885688"), true);
  });
});

test("production auth cookies are host-only, secure, strict, and http-only", () => {
  const cookie = createAuthCookie({ secure: true });
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/download-isolation.test.mjs
```

Expected: failures because the trusted widget endpoint and separate download password do not exist.

- [ ] **Step 3: Implement the trusted iframe and download checks**

```js
export function verifyDownloadPassword(password) {
  return safeEqual(String(password || ""), process.env.HTML_WORKBENCH_DOWNLOAD_PASSWORD || "885688");
}

export function isTrustedAdminOrigin(request) {
  const origin = request.headers.get("origin");
  return origin === getRuntimeConfig().adminOrigin;
}
```

Move the current download panel markup and script from `api/view.mjs` into
`api/download-widget.mjs`. The widget posts to the admin-origin `/api/download`;
`api/view.mjs` injects:

```html
<iframe
  class="html-workbench-download-frame"
  src="${adminOrigin}/public-download-widget/${record.id}"
  title="下载当前文件"
  sandbox="allow-forms allow-scripts allow-downloads allow-same-origin"
></iframe>
```

Validate the request Origin in `api/download.mjs`, allow same-origin admin requests,
and set an explicit `frame-ancestors https://page.wekki.fun` Content Security Policy
on the widget response.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/download-isolation.test.mjs tests/server-io.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit download isolation**

```powershell
git add api/download-widget.mjs api/view.mjs api/download.mjs lib/auth.mjs server.js vercel.json tests/download-isolation.test.mjs tests/server-io.test.mjs
git commit -m "Isolate public download password UI"
```

### Task 3: Signed Cursor and Ordered Record Index Primitives

**Files:**
- Create: `lib/cursor.mjs`
- Create: `lib/record-index.mjs`
- Create: `tests/cursor.test.mjs`
- Create: `tests/record-pagination.test.mjs`
- Modify: `lib/constants.mjs`

**Interfaces:**
- Produces: `normalizePageRequest(url)`, `encodePageCursor(state)`, `decodePageCursor(cursor, filters)`, `buildRecordIndexPath(record)`, `buildRecordIndexDocument(record)`, and `matchesRecord(record, filters)`.
- Cursor state shape: `{ version: 1, storageCursor: string | null, query: string, documentType: string }`.
- Index document shape: `{ indexPath, recordPath, record: publicRecordFields }`.
- Readiness marker path: `record-index-state/v1-ready.json`.

- [ ] **Step 1: Write failing cursor and index tests**

```js
test("cursor round-trips and is bound to filters", () => {
  const cursor = encodePageCursor({
    version: 1,
    storageCursor: "blob-next",
    query: "报告",
    documentType: "分析报告"
  });
  assert.deepEqual(
    decodePageCursor(cursor, { query: "报告", documentType: "分析报告" }),
    { version: 1, storageCursor: "blob-next", query: "报告", documentType: "分析报告" }
  );
  assert.throws(
    () => decodePageCursor(cursor, { query: "原型", documentType: "分析报告" }),
    (error) => error.status === 400
  );
});

test("reverse timestamp index paths sort newest first", () => {
  const older = buildRecordIndexPath({ id: ID_A, uploadedAt: "2026-01-01T00:00:00.000Z" });
  const newer = buildRecordIndexPath({ id: ID_B, uploadedAt: "2026-07-24T00:00:00.000Z" });
  assert.ok(newer.localeCompare(older) < 0);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test tests/cursor.test.mjs tests/record-pagination.test.mjs
```

Expected: module-not-found failures for the new cursor and index modules.

- [ ] **Step 3: Implement cursor signing and index helpers**

```js
export function encodePageCursor(state) {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", getCursorSecret()).update(payload).digest("base64url");
  return `v1.${payload}.${signature}`;
}

export function decodePageCursor(cursor, filters) {
  const [prefix, payload, signature] = String(cursor || "").split(".");
  assertSigned(prefix, payload, signature);
  const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (state.query !== filters.query || state.documentType !== filters.documentType) {
    throw badCursor();
  }
  return state;
}
```

Use a 16-digit reverse timestamp based on `9_999_999_999_999_999 - Date.parse(uploadedAt)`.
Normalize query text to trimmed lowercase, cap it at 120 characters, and reject limits
outside 1 through 100.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/cursor.test.mjs tests/record-pagination.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit pagination primitives**

```powershell
git add lib/cursor.mjs lib/record-index.mjs lib/constants.mjs tests/cursor.test.mjs tests/record-pagination.test.mjs
git commit -m "Add signed cursors and ordered record indexes"
```

### Task 4: Storage Index Maintenance, Pagination, and Migration

**Files:**
- Modify: `lib/storage.mjs`
- Modify: `api/uploads.mjs`
- Modify: `api/delete-upload.mjs`
- Modify: `tests/record-pagination.test.mjs`
- Create: `scripts/migrate-record-index.mjs`
- Create: `tests/record-index-migration.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 3 cursor and index helpers.
- Produces: `saveIndexedRecord(record, previousRecord?)`, `deleteIndexedRecord(record)`, `listRecordsPage(options)`, and `migrateRecordIndex(options)`.
- `listRecordsPage()` returns `{ records, page: { limit, hasMore, nextCursor } }`.

- [ ] **Step 1: Add failing storage pagination and mutation tests**

```js
test("1205 indexed records page without omissions or duplicates", async () => {
  await seedLocalRecords(1205);
  const seen = new Set();
  let cursor = null;
  do {
    const result = await listRecordsPage({ limit: 50, cursor, query: "", documentType: "" });
    for (const record of result.records) {
      assert.equal(seen.has(record.id), false);
      seen.add(record.id);
    }
    cursor = result.page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 1205);
});

test("replace removes the previous timestamp index and writes the new index", async () => {
  const original = await saveIndexedRecord(recordAt("2026-01-01T00:00:00.000Z"));
  const replaced = await saveIndexedRecord(recordAt("2026-07-24T00:00:00.000Z"), original);
  assert.deepEqual(await listIndexPaths(), [buildRecordIndexPath(replaced)]);
});

test("existing records without a completed index return a maintenance response", async () => {
  await seedCanonicalRecords(2);
  await assert.rejects(
    () => listRecordsPage({ limit: 50, cursor: null, query: "", documentType: "" }),
    (error) => error.status === 503 && error.code === "record_index_not_ready"
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test tests/record-pagination.test.mjs tests/record-index-migration.test.mjs
```

Expected: failures because indexed save, page, and migration functions do not exist.

- [ ] **Step 3: Implement bounded page reads and index maintenance**

For Blob mode, call:

```js
const result = await list({
  prefix: RECORD_INDEX_PREFIX,
  limit: scanLimit,
  cursor: storageCursor || undefined
});
```

Read index documents with a concurrency limit of 12. Each Blob `list()` call uses
`limit: requestedLimit - matchedRecords.length`, so every returned object is consumed
before its SDK cursor is retained and no unconsumed object is skipped. Continue scanning
while fewer than the requested number of matching records have been collected and
`hasMore` is true. Encode the final Blob cursor together with normalized filters. Local
mode lists index filenames lexicographically and uses the last consumed filename as its
storage cursor.

Replace direct `saveRecord()` mutation calls in upload, replace, and rollback paths with
`saveIndexedRecord()`. Delete both record and index through `deleteIndexedRecord()`.
Before listing, require `record-index-state/v1-ready.json` whenever canonical records
already exist. If the marker is missing, throw a status-503 error with code
`record_index_not_ready` instead of falling back to the first 1000 records.

- [ ] **Step 4: Implement idempotent migration**

```js
export async function migrateRecordIndex({ dryRun = false, onProgress = () => {} } = {}) {
  const summary = { scanned: 0, created: 0, repaired: 0, skipped: 0, failed: 0 };
  for await (const record of iterateAllRecords()) {
    summary.scanned += 1;
    await ensureRecordIndex(record, { dryRun, summary });
    onProgress({ ...summary });
  }
  await removeOrphanIndexes({ dryRun, summary });
  if (!dryRun && summary.failed === 0) {
    await writeRecordIndexReadyMarker({ version: 1, completedAt: new Date().toISOString() });
  }
  return summary;
}
```

Add scripts:

```json
{
  "scripts": {
    "migrate:record-index": "node scripts/migrate-record-index.mjs",
    "migrate:record-index:dry-run": "node scripts/migrate-record-index.mjs --dry-run"
  }
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test tests/record-pagination.test.mjs tests/record-index-migration.test.mjs tests/storage-streaming.test.mjs
```

Expected: all selected tests pass, including 1205-record pagination.

- [ ] **Step 6: Commit storage pagination and migration**

```powershell
git add lib/storage.mjs api/uploads.mjs api/delete-upload.mjs scripts/migrate-record-index.mjs package.json tests/record-pagination.test.mjs tests/record-index-migration.test.mjs tests/storage-streaming.test.mjs
git commit -m "Paginate and migrate upload record indexes"
```

### Task 5: Server-Paginated Admin Client

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `tests/ui-loading.test.mjs`

**Interfaces:**
- Consumes: `GET /api/uploads?limit=50&cursor=&q=&documentType=` from Task 4.
- Client page state: `{ nextCursor, hasMore, activeQueryKey, requestController }`.
- Produces: `loadRecords({ append })`, which replaces or appends ID-deduplicated records.

- [ ] **Step 1: Write failing client pagination tests**

```js
test("initial records request asks the server for 50 rows", () => {
  assert.match(appSource, /api\/uploads\?[^"'`]*limit=50/);
});

test("load more sends nextCursor and appends deduplicated rows", () => {
  assert.match(appSource, /nextCursor/);
  assert.match(appSource, /new Map\(.*record\.id/s);
});

test("search and type filters are sent to the server and reset the cursor", () => {
  assert.match(appSource, /searchParams\.set\("q"/);
  assert.match(appSource, /searchParams\.set\("documentType"/);
  assert.match(appSource, /resetPagination/);
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
node --test tests/ui-loading.test.mjs
```

Expected: failures because “load more” still slices a fully loaded local array.

- [ ] **Step 3: Implement remote pagination and stale-request protection**

```js
async function loadRecords({ append = false } = {}) {
  if (!append) {
    state.recordRequestController?.abort();
    state.recordRequestController = new AbortController();
    state.nextCursor = null;
  }
  const params = new URLSearchParams({ limit: String(RECORDS_PAGE_SIZE) });
  if (append && state.nextCursor) params.set("cursor", state.nextCursor);
  if (state.query) params.set("q", state.query);
  if (state.documentType) params.set("documentType", state.documentType);
  const payload = await api(`/api/uploads?${params}`, {
    signal: state.recordRequestController.signal
  });
  const records = append ? deduplicateById([...state.records, ...payload.records]) : payload.records;
  setRecordCollection(records);
  state.nextCursor = payload.page.nextCursor;
  state.hasMore = payload.page.hasMore;
  renderRecords();
}
```

Replace the local visible-count load-more handler with `loadRecords({ append: true })`.
Search remains debounced, but each settled search and type change starts a new server query.
Refresh clears the query cursor and requests page one.

- [ ] **Step 4: Run UI and API tests and verify GREEN**

Run:

```powershell
node --test tests/ui-loading.test.mjs tests/server-io.test.mjs tests/record-pagination.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the paginated client**

```powershell
git add public/app.js public/index.html tests/ui-loading.test.mjs
git commit -m "Load upload records with server pagination"
```

### Task 6: Real Upload Progress and Loading Motion

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `tests/ui-loading.test.mjs`

**Interfaces:**
- Produces: upload states `idle`, `uploading`, `processing`, `success`, and `error`.
- `uploadWithProgress(url, formData, onProgress)` returns parsed API JSON and uses
  `XMLHttpRequest.upload.onprogress` for transferred-byte progress.

- [ ] **Step 1: Write failing animation and progress tests**

```js
test("upload uses browser byte progress before the processing state", () => {
  assert.match(appSource, /XMLHttpRequest/);
  assert.match(appSource, /xhr\.upload\.addEventListener\("progress"/);
  assert.match(appSource, /setUploadPhase\("processing"\)/);
});

test("the page includes accessible upload progress and records skeletons", () => {
  assert.match(indexSource, /role="progressbar"/);
  assert.match(indexSource, /aria-valuenow/);
  assert.match(indexSource, /records-skeleton/);
});

test("motion is disabled for reduced-motion users", () => {
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(stylesSource, /animation:\s*none/);
});
```

- [ ] **Step 2: Run the UI test and verify RED**

Run:

```powershell
node --test tests/ui-loading.test.mjs
```

Expected: failures because upload uses `fetch()` without upload progress and the new motion selectors do not exist.

- [ ] **Step 3: Add semantic loading markup and state transitions**

```js
function setUploadPhase(phase, progress = 0) {
  state.uploadPhase = phase;
  elements.uploadProgress.hidden = phase === "idle";
  elements.uploadProgressBar.value = phase === "uploading" ? progress : 100;
  elements.uploadProgressBar.toggleAttribute("data-indeterminate", phase === "processing");
  elements.uploadProgressLabel.textContent = uploadPhaseLabel(phase, progress);
}
```

Use XHR only for multipart upload and replacement requests that need byte progress. Keep
the existing Fetch wrapper for JSON and list requests. Mark appended rows with
`data-entering`, remove that attribute on `animationend`, and apply a short success class
to a newly uploaded record.

- [ ] **Step 4: Add motion styles with fixed dimensions**

```css
.record-row[data-entering="true"] {
  animation: record-enter 180ms ease-out both;
}

.upload-progress[data-phase="processing"] .upload-progress__bar {
  animation: processing-sweep 900ms ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation: none !important;
    transition-duration: 0.01ms !important;
  }
}
```

Skeleton rows must use the same grid/table column widths as loaded rows so that the
records section does not resize when data arrives.

- [ ] **Step 5: Run the UI test and verify GREEN**

Run:

```powershell
node --test tests/ui-loading.test.mjs
```

Expected: all UI loading, pagination, progress, and reduced-motion tests pass.

- [ ] **Step 6: Commit state-driven motion**

```powershell
git add public/index.html public/app.js public/styles.css tests/ui-loading.test.mjs
git commit -m "Add upload progress and loading motion"
```

### Task 7: Dual-Service Deployment, DNS Documentation, and Migration Gate

**Files:**
- Create: `deploy/self-host/html-workbench-content.service`
- Modify: `deploy/self-host/html-workbench.service`
- Modify: `deploy/self-host/html-workbench.env.example`
- Modify: `deploy/self-host/nginx.conf`
- Modify: `deploy/self-host/deploy.sh`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Modify: `README.md`
- Modify: `tests/deploy-readiness.test.mjs`
- Modify: `tests/docker-runtime.test.mjs`

**Interfaces:**
- Admin health: `http://127.0.0.1:3000/healthz`.
- Content health: `http://127.0.0.1:3001/healthz`.
- Deployment must run `npm run migrate:record-index` before restarting the content service.

- [ ] **Step 1: Write failing deployment contract tests**

```js
test("self-host deployment installs two loopback-only services", () => {
  assert.match(adminService, /HTML_WORKBENCH_ROLE=admin/);
  assert.match(contentService, /HTML_WORKBENCH_ROLE=content/);
  assert.match(contentService, /Environment=PORT=3001/);
  assert.match(deployScript, /migrate:record-index/);
});

test("nginx isolates the admin and public hosts", () => {
  assert.match(nginx, /server_name ho\.wekki\.fun/);
  assert.match(nginx, /server_name page\.wekki\.fun/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3001/);
  assert.match(nginx, /location \^~ \/api\/[\s\S]*return 404/);
});
```

- [ ] **Step 2: Run deployment tests and verify RED**

Run:

```powershell
node --test tests/deploy-readiness.test.mjs tests/docker-runtime.test.mjs
```

Expected: failures because the content service and dual-domain Nginx configuration do not exist.

- [ ] **Step 3: Add two systemd services and Nginx server blocks**

Admin service environment:

```ini
Environment=HTML_WORKBENCH_ROLE=admin
Environment=HOST=127.0.0.1
Environment=PORT=3000
```

Content service environment:

```ini
Environment=HTML_WORKBENCH_ROLE=content
Environment=HOST=127.0.0.1
Environment=PORT=3001
ProtectSystem=strict
ReadOnlyPaths=/var/lib/html-workbench
```

Nginx sends `ho.wekki.fun` to port 3000, redirects `/view/*` to
`https://page.wekki.fun$request_uri`, sends only `/view/*` and `/healthz` for
`page.wekki.fun` to port 3001, and returns 404 for all other public-host paths.

- [ ] **Step 4: Update deployment and Docker orchestration**

The deployment order is:

```bash
npm ci --omit=dev
npm run migrate:record-index
systemctl daemon-reload
systemctl restart html-workbench html-workbench-content
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3001/healthz
nginx -t
systemctl reload nginx
```

Docker Compose adds separate `admin` and `content` services from the same image and named
volume. Admin publishes loopback port 3000; content publishes loopback port 3001 and mounts
the volume read-only.

- [ ] **Step 5: Document DNS, environment variables, certificates, migration, and rollback**

README must state:

```text
Host record: page
Type: A
Value: 163.7.4.158
TTL: 600
```

Document `HTML_WORKBENCH_ADMIN_ORIGIN`, `HTML_WORKBENCH_PUBLIC_ORIGIN`,
`HTML_WORKBENCH_DOWNLOAD_PASSWORD`, and `HTML_WORKBENCH_CURSOR_SECRET`. Include Certbot
commands for `page.wekki.fun`, migration dry-run, migration execution, both service status
commands, and rollback to the previous Git commit.

- [ ] **Step 6: Run deployment tests and verify GREEN**

Run:

```powershell
node --test tests/deploy-readiness.test.mjs tests/docker-runtime.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit deployment support**

```powershell
git add deploy/self-host/html-workbench-content.service deploy/self-host/html-workbench.service deploy/self-host/html-workbench.env.example deploy/self-host/nginx.conf deploy/self-host/deploy.sh docker-compose.yml Dockerfile README.md tests/deploy-readiness.test.mjs tests/docker-runtime.test.mjs
git commit -m "Deploy isolated admin and public services"
```

### Task 8: Full Verification, Review, GitHub Sync, and Production Deployment

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes all earlier task outputs.
- Produces a clean branch, aligned GitHub SHA, two active services, migrated index, and verified public routes.

- [ ] **Step 1: Run the complete local verification**

Run:

```powershell
npm.cmd run check
docker compose config --quiet
git diff --check
```

Expected: zero failed tests, Compose exits 0, and `git diff --check` emits no errors.

- [ ] **Step 2: Run independent implementation and security review**

Review specifically for:

- Any admin API reachable from the content role.
- Any password UI or secret injected into uploaded HTML.
- Cursor tampering, replay across filters, or unstable cross-page ordering.
- Missing index maintenance in upload, replace, rollback, and delete paths.
- Race conditions between stale list requests.
- Fake upload progress or motion that ignores reduced-motion settings.
- Deployment ordering that serves the new list API before migration succeeds.

Fix findings with a failing regression test first, rerun focused tests, then rerun
`npm.cmd run check`.

- [ ] **Step 3: Push the verified branch**

```powershell
git status --short --branch
git push origin owncnd_codex/html
git rev-parse HEAD
git rev-parse origin/owncnd_codex/html
```

Expected: local and remote SHAs match.

- [ ] **Step 4: Prepare DNS and HTTPS**

Verify `page.wekki.fun` resolves to `163.7.4.158`. If the DNS record is not present,
stop before switching Nginx and report the required Fire Engine DNS record. After DNS
resolves, issue or expand the Let's Encrypt certificate so it covers `page.wekki.fun`.

- [ ] **Step 5: Deploy code, migrate indexes, and start both services**

On the server:

```bash
cd /opt/html-workbench
git fetch origin owncnd_codex/html
git checkout owncnd_codex/html
git reset --hard origin/owncnd_codex/html
npm ci --omit=dev
npm run migrate:record-index:dry-run
npm run migrate:record-index
cp deploy/self-host/html-workbench.service /etc/systemd/system/
cp deploy/self-host/html-workbench-content.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable html-workbench html-workbench-content
systemctl restart html-workbench html-workbench-content
nginx -t
systemctl reload nginx
```

- [ ] **Step 6: Verify production boundaries and application behavior**

Run:

```bash
record_file=$(find /var/lib/html-workbench/records -maxdepth 1 -name '*.json' -print -quit)
test -n "$record_file"
record_id=$(basename "$record_file" .json)
curl -fsS https://ho.wekki.fun/healthz
curl -fsS https://page.wekki.fun/healthz
curl -I "https://ho.wekki.fun/view/$record_id"
curl -I "https://page.wekki.fun/api/uploads"
systemctl is-active html-workbench
systemctl is-active html-workbench-content
git -C /opt/html-workbench rev-parse HEAD
```

Expected:

- Both health endpoints return 200.
- The admin view URL redirects to the same path on `page.wekki.fun`.
- Public `/api/uploads` returns 404.
- Both services are `active`.
- Server SHA equals the pushed GitHub SHA.

- [ ] **Step 7: Record final evidence**

Report the commit SHA, test count, migration summary, service states, DNS/HTTPS status,
admin redirect result, public API isolation result, and a working uploaded page URL.
