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
- [ ] Add failing tests for detection, active-slide overrides, restoration and notes.
- [ ] Implement `public/editor-presentation.mjs` with scoped temporary state.
- [ ] Verify tests and serialization preservation.

## Task 2: Workbench Integration
- [ ] Add page/module tabs, lazy thumbnails and fixed-ratio scaled canvas.
- [ ] Connect page switching and selection bounds without clearing history.
- [ ] Add undoable raster replacement and notes editing with validation.
- [ ] Keep ordinary HTML behavior and save errors unchanged.

## Task 3: Acceptance
- [ ] Add browser tests for page/text/style/image/notes edit, undo/redo and save.
- [ ] Test original playback after save and no leaked editor state.
- [ ] Run full checks and desktop/mobile visual QA using real sample copy.
- [ ] Review, commit and provide local URL; leave production sample unchanged.
