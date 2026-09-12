# Presentation Editor Implementation Plan

> **For agentic workers:** Use subagent-driven-development for isolated adapter work and local integration.

**Goal:** Edit existing HTML slide decks page by page without breaking playback.

**Architecture:** Independent slide adapter plus existing editor shell/history/API.

**Tech Stack:** Browser DOM, native JavaScript modules, Node test runner, Chrome browser tests.

## Global Constraints

- Preserve scripts and original page attributes; never enable uploaded scripts in the editor.
- No page insertion/deletion/reorder; no production source mutation.
- Same save API, version conflict checks and 30 MiB bound.

## Task 1: Presentation Adapter
- [x] Add failing tests for detection, active-slide overrides, restoration and notes.
- [x] Implement `public/editor-presentation.mjs` with scoped temporary state.
- [x] Verify tests and serialization preservation.

## Task 2: Workbench Integration
- [x] Add page/module tabs, lazy thumbnails and fixed-ratio scaled canvas.
- [x] Connect page switching and selection bounds without clearing history.
- [x] Add undoable raster replacement and notes editing with validation.
- [x] Keep ordinary HTML behavior and save errors unchanged.

## Task 3: Acceptance
- [x] Add browser tests for page/text/style/image/notes edit, undo/redo and save.
- [x] Test original playback after save and no leaked editor state.
- [x] Run full checks and desktop/mobile visual QA using real sample copy.
- [x] Review, commit and provide local URL; leave production sample unchanged.

## Verification

- `npm.cmd run check`: 199 passed, 3 opt-in browser entries skipped.
- Ordinary editor Chrome acceptance: 30 passed.
- Adapter targeted tests including Chrome: 23 passed.
- Presentation Chrome acceptance: synthetic fixture and real 23-page sample passed, including all page dimensions, footer bounds, notes serialization, original playback, and desktop/mobile selection outlines.
- Real local API smoke: upload sample copy, save/restore notes, and read public content passed. Production source was not modified; this feature is not deployed.
- Independent review findings on hidden display and structural thumbnail CSS fixed in `c1b3324` and `d78919d`; follow-up review found no remaining blockers in those fixes.
