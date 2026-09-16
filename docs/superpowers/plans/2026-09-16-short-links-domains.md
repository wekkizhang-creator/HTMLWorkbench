# Short Links And Domain Migration Implementation Plan

> Use subagent-driven-development for the isolated storage and deployment tasks; the coordinator owns runtime routing and full integration.

**Goal:** Move management to desk.wekkii.cn and assign short ho.wekkii.cn links only to new uploads, preserving every existing public link.

**Architecture:** Immutable code-to-UUID reservations under the existing writer lease, per-record public identity, dual content-origin routing, transactional host configuration migration.

**Tech Stack:** Native Node ESM, local/Blob storage, Nginx/systemd, Node tests and existing Chrome/Playwright acceptance.

## Global Constraints

- Exact new origins: `https://desk.wekkii.cn`, `https://ho.wekkii.cn`.
- Exact legacy origins: `https://ho.wekki.fun`, `https://page.wekki.fun`.
- Only new uploads receive 10-character alphanumeric case-sensitive codes. Internal UUID contracts remain unchanged.
- No old-record backfill, public source rewrite, unrelated main-checkout edits or premature production mutation.
- Existing worktree: `.worktrees/public-origin-pagination`; baseline `75e0de1`.
- Changes to active production services wait for DNS/TLS readiness and successful tests/review.

## Task 1: Public Identity And Durable Reservations

Own `lib/public-links.mjs` (new), `lib/storage.mjs`, `lib/records.mjs`, `api/uploads.mjs`, and `tests/public-links.test.mjs` (new).

Interfaces supplied to the coordinator:

```js
// lib/public-links.mjs: no storage or runtime imports
export const PUBLIC_VIEW_RE = /^\/view\/([0-9a-fA-F-]{36}|[A-Za-z0-9]{10})(?:\/(.*))?$/;
export function isPublicToken(value) {} // UUID-shaped or 10-character alphanumeric
export function publicViewPath(record, kind = record.uploadKind) {} // /view/code-or-id, ZIP slash
// lib/storage.mjs
export function generatePublicCode() {} // node:crypto randomInt, 10 chars; keep formatter edge-compatible
export async function assignPublicLink(record, { generateCode = generatePublicCode } = {}) {} // locked, returns new record
export async function getRecordByPublicToken(token) {} // read-only, null on missing/deleted/malformed
```

- [x] Write red tests: 10 alphanumeric characters; duplicate generated codes retry without overwrite; 10 collisions fail; concurrent allocators cannot share a code; failed/deleted reservations never reused; invalid/mismatched mappings are missing.
- [x] Implement reservation creation in the existing writer lease using existing JSON storage APIs. Reservation path `public-links/<code>.json`, shape `{ version: 1, code, id }`. New records gain `publicCode`, `publicOrigin: getRuntimeConfig().publicOrigin` and absolute `url`.
- [x] Call `assignPublicLink` only for freshly constructed upload records (both HTML and ZIP) inside the existing POST mutation. Do not assign in generic save/replacement/migration operations.
- [x] Preserve code/origin/url identity through replacement and rollback paths in records/storage. Keep old relative UUID links unchanged. Delete canonical records without deleting reservations.
- [x] Run focused tests with local and fake-Blob coverage, self-review, commit owned files, report API and red/green evidence in `.superpowers/sdd/short-links-storage-report.md`.

## Task 2: Runtime And HTTP Compatibility

Coordinator owns `lib/runtime.mjs`, `lib/security-config.mjs`, `api/view.mjs`, `api/download-widget.mjs`, `server.js`, runtime/security/editor API tests, integration tests, README.

- [x] Red tests for new production constants, legacy public URL resolution, per-record new origin, both content host allowlists, unknown hosts and management isolation.
- [x] Runtime adds `legacyAdminOrigin`/`legacyPublicOrigin` (production fixed legacy defaults; nonproduction configurable with current origins as defaults), `isPublicHost(host)`, and preserves the existing runtime exports. `buildPublicViewUrl` resolves legacy relative links against the legacy origin and keeps absolute record URLs.
- [x] Use `PUBLIC_VIEW_RE` in both native/Vercel host policies. Resolve short codes via `getRecordByPublicToken`; keep authenticated record validation UUID-only. Build injected ZIP base from `publicViewPath(record)`.
- [x] Route old-manager GET/HEAD requests safely to the new manager, with UUID /view requests to the legacy public origin; reject unsafe old-manager requests. Native and Vercel policies agree.
- [x] Download-widget CSP includes both exact public origins. Regression-test CSRF, host-only cookies and credential-free content service.
- [x] Integration test new upload, old seeded record, public source/ZIP assets, replacement and rollback identity, delete404, editor source URL/base, and public management denial. Existing fixtures asserting production origins are updated only where they mean current origins, not legacy samples.

## Task 3: Transactional Deployment Configuration

Own `deploy/self-host/*`, `deploy/docker/*` and deployment examples if present, `.github/workflows/*` only as needed, plus deployment-specific tests (`tests/deploy-readiness.test.mjs`, `tests/docker-runtime.test.mjs`). Do not edit coordinator runtime files or README.

- [x] Red tests for four-host configuration, preserving old TLS blocks, idempotent managed migration, exact new-host health checks and previous-host rollback checks.
- [x] Add the new manager/content host configurations without removing legacy hosting. Shared admin snippet must delegate /view redirects to application routing instead of pinning all IDs to one origin. Legacy manager browser redirects are handled consistently and unsafe methods rejected.
- [x] Migrate only the production environment origin settings while preserving credentials/comments/unrelated values. Update credential-free content example. Snapshot any new/modified Nginx files and restore them plus environments on failure.
- [x] Preserve existing Certbot-managed TLS blocks on repeat deployments. Do not acquire certificates, change DNS, push or deploy from this task; coordinator owns live actions.
- [x] Run deployment/Docker-focused tests, self-review, commit owned files, report in `.superpowers/sdd/short-links-deployment-report.md`.

## Task 4: Final Verification And Release

Local implementation and independent reviews are complete through `402043e`.
Final check: 256 passed, 6 opt-in entries skipped, zero failures; explicit browser
acceptance: 82 passed; dependency audit: zero vulnerabilities. On 2026-09-16,
both new domains resolved to `163.7.4.158`; their HTTPS certificate was issued
and release `5b92512f7fe3c37ae0e9d944d4f6affa94a008df` was activated.
Both services are active. Production browser acceptance passed upload, short
links, slide/notes editing, draft recovery, export, desktop/mobile pan/zoom,
save/public playback, rollback and deletion. All 38 legacy public links returned
200; all 87 preexisting record/source files remained byte-identical. Four-host
HTTPS, legacy management redirect and public management isolation passed.
The temporary browser-test upload was deleted. The data/config backup is
`/var/backups/html-workbench/domains-5b92512f7fe3c37ae0e9d944d4f6affa94a008df`.

- [x] Independent task reviews for storage and deployment; fix material issues, then broad final review.
- [x] `npm.cmd run check`; opt-in editor and domain/link browser acceptance; `git diff --check`; audit current lockfile.
- [x] Confirm both new DNS names and TLS; if unavailable, finish local code/verification and clearly report the deployment blocker without breaking the old service.
- [x] Push verified immutable commit only to the existing feature branch. Activate with the current deployment implementation, not an older deploy script whose domain rules are stale.
- [x] Check exact deployed SHA, both services, HTTPS for all four hosts, old read-only public document, temporary new short-link upload/edit/rollback/delete and cleanup. Keep secrets out of artifacts/log output.
