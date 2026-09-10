# HTML Visual Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a protected visual editor for published single HTML files, with direct text editing, element styling, module deletion, undo/redo, and save-in-place rollback support.

**Architecture:** The admin origin exposes an authenticated source read/write API and a static editor workbench. The browser parses HTML into a script-disabled same-origin iframe, attaches transient node IDs for selection, and serializes a cleaned document back to the existing storage and previous-version flow. The content origin remains read-only and only serves published /view routes.

**Tech Stack:** Node.js 20, native Fetch Request/Response APIs, local or Vercel Blob storage, vanilla HTML/CSS/ES modules, Node test runner.

## Global Constraints

- Visual editing supports single HTML uploads only; ZIP packages remain read-only.
- The editor is admin-only and must not expand the content-role route allowlist.
- The iframe uses allow-same-origin without allow-scripts.
- Saving immediately updates the existing public URL and preserves the pre-save version in the existing rollback slot.
- Edited HTML must remain at or below 30 MB.
- No frontend framework or new runtime dependency.
- Uploaded script, style, and business attributes must be preserved in the saved file.

---

### Task 1: Authenticated HTML Source API

**Files:**
- Create: api/edit-upload.mjs
- Create: lib/editor-content.mjs
- Create: tests/editor-api.test.mjs
- Modify: server.js
- Modify: vercel.json

**Interfaces:**
- Produces: createEditorVersion(record, buffer) returning a quoted SHA-256 version string.
- Produces: assertEditableRecord(record) throwing status 404 or 409.
- Produces: GET and PUT handlers for /api/uploads/:id/content.
- Consumes: getRecord, getUploadContent, savePreviousVersion, saveUpload, saveIndexedRecord, withRecordMutation, buildReplacementRecord, and publicRecord.

- [ ] **Step 1: Write failing API and helper tests**

~~~~javascript
test("editor versions change with record state or content", () => {
  const record = { id: TEST_ID, uploadedAt: "2026-09-11T00:00:00.000Z" };
  assert.notEqual(
    createEditorVersion(record, Buffer.from("<h1>A</h1>")),
    createEditorVersion(record, Buffer.from("<h1>B</h1>"))
  );
});

test("content role rejects editor source routes", async () => {
  const response = await request(contentServer.origin, "GET", "/api/uploads/" + TEST_ID + "/content");
  assert.equal(response.status, 404);
});

test("admin editor API reads, saves and detects stale versions", async () => {
  const first = await authorizedRequest(adminServer, "GET", "/api/uploads/" + TEST_ID + "/content");
  assert.equal(first.status, 200);
  const saved = await authorizedRequest(adminServer, "PUT", "/api/uploads/" + TEST_ID + "/content", {
    headers: { "Content-Type": "text/html; charset=utf-8", "If-Match": first.headers.etag },
    body: "<!doctype html><h1>Edited</h1>"
  });
  assert.equal(saved.status, 200);
  const stale = await authorizedRequest(adminServer, "PUT", "/api/uploads/" + TEST_ID + "/content", {
    headers: { "Content-Type": "text/html; charset=utf-8", "If-Match": first.headers.etag },
    body: "<h1>Stale</h1>"
  });
  assert.equal(stale.status, 409);
});
~~~~

- [ ] **Step 2: Run the focused tests and verify failure**

Run: node --test tests/editor-api.test.mjs

Expected: FAIL because api/edit-upload.mjs and lib/editor-content.mjs do not exist.

- [ ] **Step 3: Implement validation and version helpers**

~~~~javascript
export function assertEditableRecord(record) {
  if (!record) throw statusError("Upload record does not exist", 404);
  if ((record.uploadKind || "html") !== "html") {
    throw statusError("ZIP packages cannot be edited", 409);
  }
  return record;
}

export function createEditorVersion(record, buffer) {
  return '"' + createHash("sha256")
    .update(String(record.id))
    .update("\0")
    .update(String(record.uploadedAt || ""))
    .update("\0")
    .update(buffer)
    .digest("hex") + '"';
}
~~~~

- [ ] **Step 4: Implement GET and PUT**

GET authenticates with managementRequestFailure, validates the UUID and HTML record, reads the current file, and returns JSON with html, public record, and version while also setting ETag.

PUT requires text/html and If-Match, rejects an empty body or content over MAX_UPLOAD_BYTES, enters withRecordMutation, re-reads record and current bytes, compares the current version, copies the current file with savePreviousVersion, saves edited bytes, rebuilds metadata with buildReplacementRecord while preserving record.title, and updates the record index.

~~~~javascript
const previousVersion = await savePreviousVersion(record);
const uploadBlob = await saveUpload(record.id, htmlBuffer, { allowOverwrite: true });
const updatedRecord = buildReplacementRecord({
  record: { ...record, previousVersion },
  fileBuffer: htmlBuffer,
  originalName: record.originalName,
  title: record.title,
  uploadBlob
});
const savedRecord = await saveIndexedRecord(updatedRecord, record);
~~~~

- [ ] **Step 5: Register self-hosted and Vercel routes**

Add editUpload to API_MODULES, route /api/uploads/:id/content before /api/uploads/:id, require the existing authorized session, and rewrite the Vercel path to /api/edit-upload?id=:id before the generic upload-record rewrite. Extend the admin-page authorization guard so /editor.html without a valid session redirects to /login.html with the complete editor URL in next.

- [ ] **Step 6: Run focused and routing tests**

Run: node --test tests/editor-api.test.mjs tests/runtime-routing.test.mjs

Expected: PASS, including content-role 404 and admin stale-write 409.

- [ ] **Step 7: Commit**

~~~~bash
git add api/edit-upload.mjs lib/editor-content.mjs server.js vercel.json tests/editor-api.test.mjs
git commit -m "Add protected HTML editor source API"
~~~~

### Task 2: Browser Editor Core

**Files:**
- Create: public/editor-core.mjs
- Create: tests/editor-core.test.mjs
- Modify: server.js

**Interfaces:**
- Produces: PROTECTED_TAGS, isProtectedElement(element), chooseEditableElement(element), labelForElement(element), assignEditorNodeIds(document), scrubEditorArtifacts(document), serializeDocument(document, doctype), and EditorHistory.
- Consumes: DOM-like Element and Document objects supplied by the browser; tests use focused fakes for selection and history.

- [ ] **Step 1: Write failing core tests**

~~~~javascript
test("smart selection chooses a meaningful block and protects document roots", () => {
  const section = fakeElement("section");
  const span = fakeElement("span", section);
  assert.equal(chooseEditableElement(span), section);
  assert.equal(isProtectedElement(fakeElement("body")), true);
});

test("history executes, undoes and redoes commands", () => {
  const values = [];
  const history = new EditorHistory();
  history.execute({ redo: () => values.push("new"), undo: () => values.push("old") });
  history.undo();
  history.redo();
  assert.deepEqual(values, ["new", "old", "new"]);
});
~~~~

- [ ] **Step 2: Run the focused tests and verify failure**

Run: node --test tests/editor-core.test.mjs

Expected: FAIL because public/editor-core.mjs does not exist.

- [ ] **Step 3: Implement selection and labels**

Use semantic block tags first, allow visible leaf elements, skip protected tags, and walk ancestors only within body. Generate readable labels from tag name, id, class, aria-label, heading text, or image alt text without exposing long page content.

- [ ] **Step 4: Implement transient IDs and serialization cleanup**

Assign data-hwb-editor-id only to body descendants. Before serialization remove data-hwb-editor-id, data-hwb-selected, and editor-owned style nodes marked data-hwb-editor-ui. Track the original contenteditable and spellcheck values for temporary text editing and restore them before serialization. Preserve all unrelated attributes and script/style elements.

- [ ] **Step 5: Implement bounded command history**

EditorHistory stores at most 100 text/style/delete commands, clears redo after a new command, and emits a change callback used to refresh toolbar state.

- [ ] **Step 6: Serve ES modules correctly**

Add .mjs => text/javascript; charset=utf-8 to server MIME_TYPES.

- [ ] **Step 7: Run tests and commit**

Run: node --test tests/editor-core.test.mjs tests/server-static.test.mjs

Expected: PASS.

~~~~bash
git add public/editor-core.mjs tests/editor-core.test.mjs server.js
git commit -m "Add visual editor DOM core"
~~~~

### Task 3: Three-Column Editor Workbench

**Files:**
- Create: public/editor.html
- Create: public/editor.css
- Create: public/editor.js
- Create: tests/editor-ui.test.mjs

**Interfaces:**
- Consumes: GET and PUT /api/uploads/:id/content and all exports from editor-core.mjs.
- Produces: an authenticated editor route with module tree, sandboxed canvas, property inspector, direct text editing, deletion, undo/redo, loading states, and unsaved-change protection.

- [ ] **Step 1: Write failing UI contract tests**

~~~~javascript
test("editor page exposes the approved workbench and safe sandbox", async () => {
  const html = await fs.readFile("public/editor.html", "utf8");
  assert.match(html, /id="moduleTree"/);
  assert.match(html, /id="editorCanvas"/);
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /allow-scripts/);
  assert.match(html, /id="styleInspector"/);
  assert.match(html, /id="saveButton"/);
});
~~~~

- [ ] **Step 2: Run the focused test and verify failure**

Run: node --test tests/editor-ui.test.mjs

Expected: FAIL because the editor assets do not exist.

- [ ] **Step 3: Build the workbench shell and responsive layout**

Use the existing Claude-inspired neutral palette and logo. Desktop uses 220px / minmax(0, 1fr) / 280px columns. At widths below 900px, left and right panels become mutually exclusive drawers opened by icon buttons. Keep the canvas independently scrollable and ensure controls never resize the canvas.

- [ ] **Step 4: Load and mount the editable document**

Read id from URLSearchParams, fetch source, redirect 401 to login with next, parse with DOMParser, store the doctype, assign transient node IDs, then set iframe.srcdoc. On load, attach parent-owned click, double-click, input, blur, submit, and navigation-prevention listeners to iframe.contentDocument.

- [ ] **Step 5: Implement selection and module tree synchronization**

On pointer move show a non-persisted outline overlay. On click call chooseEditableElement, update the selected node ID, render breadcrumb navigation, scroll the matching tree row into view, and read computed plus inline styles into the inspector.

- [ ] **Step 6: Implement direct text editing**

On double-click choose the nearest safe text container, capture its previous innerHTML, enable contenteditable, focus it, and create one history command on blur only when content changed.

- [ ] **Step 7: Implement style editing and advanced CSS**

Common controls write individual inline properties. Advanced CSS validates by assigning to a temporary element.style.cssText before applying. Each committed control change creates one history command containing old and new cssText.

- [ ] **Step 8: Implement delete, undo, redo, and dirty state**

Delete detaches the selected node while retaining parent and next-sibling references for undo. Toolbar buttons and Ctrl+Z / Ctrl+Shift+Z call EditorHistory. Any command marks the editor dirty and enables save.

- [ ] **Step 9: Implement save, preview, and errors**

Clone the iframe document, scrub editor artifacts, serialize with the original doctype, enforce client-side byte size, and PUT with If-Match. Keep dirty state on failures; on success update ETag, clear history, show success status, and open the existing public record URL from the API payload for preview.

- [ ] **Step 10: Run UI tests and commit**

Run: node --test tests/editor-ui.test.mjs tests/ui-loading.test.mjs

Expected: PASS.

~~~~bash
git add public/editor.html public/editor.css public/editor.js tests/editor-ui.test.mjs
git commit -m "Build three-column HTML editor"
~~~~

### Task 4: Upload Record Edit Action

**Files:**
- Modify: public/app.js
- Modify: public/styles.css
- Modify: tests/editor-ui.test.mjs

**Interfaces:**
- Consumes: record.uploadKind and record.id from paginated upload records.
- Produces: an Edit action for single HTML rows that navigates to /editor.html?id=<id>.

- [ ] **Step 1: Extend the failing UI test**

~~~~javascript
assert.match(appSource, /data-action="edit"/);
assert.match(appSource, /record\.uploadKind[^]*html/);
assert.match(appSource, /editor\.html\?id=/);
~~~~

- [ ] **Step 2: Run the test and verify failure**

Run: node --test tests/editor-ui.test.mjs

Expected: FAIL because the upload list has no Edit action.

- [ ] **Step 3: Add icon, row action, and navigation**

Add a lucide-style pencil icon to the existing icon map. Render Edit only when uploadKind is html. In delegated action handling, navigate to /editor.html?id=<encoded id>. Keep the widened operation column usable at desktop and mobile widths.

- [ ] **Step 4: Run tests and commit**

Run: node --test tests/editor-ui.test.mjs tests/record-pagination.test.mjs

Expected: PASS.

~~~~bash
git add public/app.js public/styles.css tests/editor-ui.test.mjs
git commit -m "Add HTML record edit action"
~~~~

### Task 5: End-to-End Regression and Visual QA

**Files:**
- Modify: tests/editor-api.test.mjs
- Modify: tests/editor-ui.test.mjs
- Modify: docs/superpowers/specs/2026-09-11-html-visual-editor-design.md only if implementation evidence requires a factual correction.

**Interfaces:**
- Consumes: completed source API, editor core, editor workbench, and upload-list action.
- Produces: regression evidence that editing changes the original public URL, rollback restores the previous HTML, and public content cannot reach management APIs.

- [ ] **Step 1: Add rollback integration coverage**

Create an HTML fixture with Chinese text, inline CSS, a script, and onclick. Save an edited version through the editor API, assert /view/:id returns the new text while retaining script markup, PATCH /api/uploads/:id, and assert /view/:id returns the original text.

- [ ] **Step 2: Run the complete automated suite**

Run: npm.cmd run check

Expected: all static checks and Node tests pass with zero failures.

- [ ] **Step 3: Start the admin and content services**

Run admin on 127.0.0.1:3000 and content on 127.0.0.1:3001 with isolated temporary storage and test credentials.

Expected: both /healthz routes return 200 on their configured hosts.

- [ ] **Step 4: Perform browser workflow QA**

Verify desktop 1440x1000 and mobile 390x844:

- Single HTML rows show Edit; ZIP rows do not.
- Editor loads without executing a fixture script.
- Click selection, double-click text, style changes, deletion, undo, redo, and save all work.
- Public preview uses the same page URL and reflects the edited HTML.
- Existing rollback restores the pre-edit page.
- Loading, saving, conflict, and network-error states do not overlap controls.

- [ ] **Step 5: Verify isolation**

Request /api/uploads/:id/content and /editor.html on the content role.

Expected: both return 404. Request them on the admin role without a session.

Expected: API returns 401 and editor page redirects to login.

- [ ] **Step 6: Commit final test hardening**

~~~~bash
git add tests/editor-api.test.mjs tests/editor-ui.test.mjs docs/superpowers/specs/2026-09-11-html-visual-editor-design.md
git commit -m "Verify HTML visual editing workflow"
~~~~
