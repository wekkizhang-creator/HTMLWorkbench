# Presentation Editing V1

Approved by the user: execute directly after inspecting the supplied 23-slide document.

## Scope

Recognize the observed `.stage > .slide` presentation family with at least two sibling slides. Show page thumbnails, preserve the document's fixed aspect ratio, edit current-page text/styles, replace raster images, and edit per-page notes. Preserve playback scripts, titles, navigation, original attributes and the public URL. No slide insertion/deletion/reordering or chart-data editing in V1. Ordinary HTML editing remains unchanged.

## Architecture

A browser-only `editor-presentation.mjs` adapter discovers slide nodes and a matching string-array `script#notes-data`. It owns temporary canvas display overrides, a current-page index and notes serialization. The main editor owns commands/history, controls and API calls. Uploaded scripts stay paused. The adapter restores temporary attributes in the cloned document before existing artifact cleanup; original nodes stay stable for history. Invalid notes JSON is left untouched and notes editing is disabled.

The iframe uses a fixed logical viewport with external scaling, so media queries cannot collapse slides when the inspector opens. Selection overlays use the same scale and offset. Thumbnails are lazy inert iframe previews with scripts, forms and nested frames blocked; temporary previews are not saved. Only the current slide's nodes appear in the module tree. Slide roots and ancestors cannot be deleted.

Raster replacement accepts decoded PNG/JPEG/WebP/GIF, embeds a data URL, clears conflicting responsive sources, preserves dimensions, and supports undo/redo. Reject invalid files and oversize output before mutation; total saved HTML retains the existing 30 MiB bound. Do not automatically update unrelated images referenced by arbitrary scripts.

Notes expose their existing HTML as an explicit source textarea, preserving formatting instead of silently flattening it. A notes edit updates only its JSON array slot, is undoable, and serializes with script-end characters escaped. Notes-only edits can be saved. Switching pages commits drafts without clearing history. Preview opens the existing published page at the current page fragment.

## Validation

Regression tests cover detection/fallback, hidden slide editing, fixed geometry and scaled selection, image validation/undo, notes preservation/undo, safe serialization and playback. Browser QA uses a representative fixture and a read-only copy of the supplied real document on desktop/mobile. Do not modify the production original or deploy without a subsequent publication decision.
