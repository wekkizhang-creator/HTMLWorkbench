# Editor Refinements

The user approved the six recommendations from the read-only audit with "按照建议处理". This is an incremental refinement of the existing editor, not a redesign.

## Scope

1. Associate history commands with their affected slide. Undo/redo selects that slide and invalidates its thumbnail, including commands affecting an off-screen slide.
2. Prefer text leaves, headings and images when directly selected. Retain parent/child navigation for container selection and preserve protected-node boundaries.
3. Rebuild thumbnails only when slide content changes. Cache serialized previews with LRU eviction, at most 8 entries and 8 MiB total. Do not remove structural siblings from previews or enable their scripts. A preview larger than the cache budget may render without being cached.
4. Persist valid unsaved source changes in IndexedDB after 750 ms of inactivity, including unblurred text and notes. Store separate records per document and editor owner; retain them for 7 days, with a 30 MiB per-document UTF-8 limit. Local storage failure must not block ordinary editing, export or server saves. Offer recovery, draft export and deletion without automatically applying any draft. A draft whose base version differs from the current server version is export-only. Never weaken If-Match conflict protection. Successful server save removes only the current owner's draft and the exact restored draft snapshot, not another tab's newer work. Export current HTML without publishing.
5. Add fit, 10-200% zoom and explicit hand/pan mode for recognized presentations. Preserve fixed logical page dimensions and selection overlay alignment. Ordinary HTML behavior remains unchanged. Controls use familiar icons and accessible names; desktop and mobile remain usable.
6. Update the compatible undici lockfile resolution to a patched release, without unrelated package upgrades or forced audit fixes.

## Boundaries

- Keep uploaded scripts paused in the editor and preserved in saved/exported source.
- No slide insertion/deletion/reordering, chart-data editing, production document mutation, or automatic publication.
- Preserve the existing API, authentication, CSRF and version checks.
- Keep changes within the current feature worktree; do not touch the unrelated main checkout.
- Verification uses synthetic fixtures and a local copy of the 23-page example.

## Verification

Regression tests reproduce selection, cross-page undo and redundant thumbnail updates before fixes. IndexedDB tests cover isolation, age/size validation, blocked storage and conditional deletion. Browser acceptance covers recovery, stale-version handling, export, storage/save failures, zoom/pan and scaled outlines at desktop/mobile sizes. Finish with existing browser suites, full Node checks, dependency audit, an independent review and a local demo.
