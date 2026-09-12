# Editor Refinements Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated core and draft-store tasks; the coordinator owns shell integration and acceptance.

**Goal:** Implement the six approved editor improvements without changing existing published documents.

**Architecture:** Extend the native editor's history metadata; add a bounded IndexedDB draft store and bounded thumbnail cache. Keep shell state and viewport interactions in the existing editor, with no framework or save API change.

**Tech Stack:** Native browser modules, IndexedDB, Node test runner, Chrome/Playwright.

## Global Constraints

- Keep uploaded scripts paused in the editor and preserved in saved/exported source.
- No slide insertion/deletion/reordering, chart-data editing, production document mutation, or automatic publication.
- Preserve the existing API, authentication, CSRF and version checks.
- Keep changes within the current feature worktree; do not touch the unrelated main checkout.
- Verification uses synthetic fixtures and a local copy of the 23-page example.

## Task 1: Selection And History Events

Owned files: `public/editor-core.mjs`, `tests/editor-core.test.mjs`.

- [x] Add failing tests for headings nested in headers/sections, spans in headings/paragraphs, images in semantic containers, protected ancestors, and existing container selection.
- [x] Make direct selection prefer the nearest heading, image or visible text leaf; text descendants inside a heading/paragraph should select that text block, not a containing section/header. Preserve container selection for clicks on the container itself and protected-ancestor rejection.
- [x] Preserve the first `onChange(state)` argument in EditorHistory and add a second argument `{ command, action }`, where action is `execute`, `undo` or `redo`, for successful mutations only. No extra event on empty undo/redo.
- [x] Run focused tests, self-review and commit only owned files. Report API/test evidence to `.superpowers/sdd/refinement-core-report.md`.

## Task 2: Local Draft Storage

Owned files: new `public/editor-drafts.mjs`, new `tests/editor-drafts.test.mjs`.

- [x] Add red tests then implement `createDraftStore({ indexedDB = globalThis.indexedDB, now = Date.now } = {})` returning async `list(documentId)`, `write(entry)`, `remove(documentId, ownerId, expectedUpdatedAt?)`, plus `close()`.
- [x] Entry shape: `{ documentId, ownerId, baseVersion, html, title, pageIndex, updatedAt }`; all IDs/baseVersion/html strings; pageIndex a nonnegative integer; updatedAt a finite millisecond timestamp. Reject empty identity/version, empty/over-30-MiB UTF-8 HTML, invalid fields and future timestamps beyond 1 minute.
- [x] Use an IndexedDB compound key `[documentId, ownerId]`, database `hwb-editor-drafts`, version 1, store `drafts`. Store schema version 1 on records. `list` returns valid, nonexpired entries for exactly that document, newest first; retention is 7 days. Prune expired records without exposing their HTML in logs. Never execute or render stored source.
- [x] Writes for an owner must not replace a newer updatedAt record with an older snapshot. `remove` with expectedUpdatedAt must delete only a record with that exact timestamp, atomically in one transaction; omit it to delete that owner unconditionally.
- [x] Database unavailable, denied, blocked or quota errors reject promptly and clearly; blocked open must time out within 2 seconds, close late connections, and be retryable. `close` releases current connection and is safe before opening.
- [x] Test real IndexedDB under opt-in `EDITOR_PLAYWRIGHT_MODULE`, plus pure validation/error tests where appropriate. Use existing external Playwright runtime; no new app dependencies.
- [x] Commit only owned files and write `.superpowers/sdd/refinement-drafts-report.md` with exact exports, test command/results and concerns.

## Task 3: Shell Integration And Viewport

Owned by coordinator: `public/editor.js`, `public/editor.html`, `public/editor.css`, thumbnail helper if useful, integration/browser tests, docs.

- [x] Add failing browser regressions for the two confirmed bugs, no thumbnail source writes on selection, recovery and zoom controls.
- [x] Wrap all history execution with affected page/element metadata. Refresh only affected previews and activate affected page on undo/redo. Keep notes-only changes out of visual thumbnail invalidation.
- [x] Implement bounded preview cache (8 entries/8 MiB), maintain positional CSS and opaque script-free thumbnail frames, invalidate on edits not selection.
- [x] Integrate 750-ms local draft capture, recovery banner and current/draft HTML export. Capture pending valid styles and notes on a clone; never auto-apply recovery or remove other owners' new drafts. Stale base versions are export-only. Storage errors remain nonblocking.
- [x] Introduce scrollable canvas surface plus fit/manual zoom (10-200%) and pointer pan mode. Fit stays default; preserve fixed source size, overlay positioning and focus. Add accessible icon controls and mobile layout.
- [x] Verify save conflicts keep drafts and successful save removes only the intended snapshots. No source scripts/helper-state leakage in exports or recovery.

## Task 4: Dependencies And Completion

- [x] Record failing audit evidence, update only compatible undici resolution and install the lockfile.
- [x] Run full Node checks, existing editor/presentation/workflow browser suites, new browser acceptance, actual sample desktop/mobile screenshots and dependency audit.
- [x] Independent task/final review; fix all material findings and rerun covering tests.
- [x] Commit final code/docs, provide local demo and state deployment status accurately.

## Acceptance Results

- `npm.cmd run check`: 215 passed, 5 opt-in browser entries skipped, 0 failed.
- Explicit browser run covering editor, refinements, IndexedDB, presentation and live publishing/rollback: 75 passed, 0 skipped, 0 failed.
- Real 23-page presentation browser acceptance: passed; 1440px and 390px screenshots inspected for clipping, overlap and canvas framing.
- `npm.cmd audit --json`: 0 vulnerabilities after the compatible undici lockfile update.
- Independent final review found one obsolete clean-owner draft issue. Commit `9c30bc3` fixes it with six red/green regressions; focused rereview approved.
- All implementation is local to the existing feature branch. No push, deployment or production document mutation was performed in this refinement task.
