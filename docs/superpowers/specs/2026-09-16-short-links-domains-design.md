# Short Links And Domain Migration

## Approved Scope

- Management moves from `https://ho.wekki.fun` to `https://desk.wekkii.cn`.
- Only newly uploaded files receive `https://ho.wekkii.cn/view/<code>` links, with a trailing slash for ZIP sites.
- Codes contain 10 random case-sensitive ASCII letters/digits. Keep internal UUIDs for storage, editor, authenticated APIs and downloads.
- Existing records retain their `https://page.wekki.fun/view/<uuid>` links. No backfill, bulk rewrite, source rewrite or content migration.
- Replacing, editing or rolling back any record retains its original public identity and origin. HTML/ZIP replacement adjusts only the necessary trailing slash.
- Keep old public hosting active. The old management host redirects browser navigation to the new manager; it must not remain an alternate authenticated management origin.

## Link Storage

Allocate public codes only in the new-upload path, under the existing storage writer lease. Persist an immutable `public-links/<code>.json` reservation with schema version, code and UUID. Retry random collisions up to 10 times and fail explicitly after exhaustion. A reservation may outlive a failed upload or deleted file; never reuse it. Both local and Blob backends must work without a listing scan.

New canonical records include `publicCode`, `publicOrigin`, and their absolute public `url`. Existing relative URLs resolve against the legacy public origin, not the new upload origin. Resolving a short code loads the reservation and then the canonical record, checks the record's code matches, and returns missing if the record was deleted or the mapping is malformed. Content readers perform no writes.

## Routing And Isolation

Accept UUID and short-code paths on the content services, preserving ZIP relative assets and base paths. Keep authenticated IDs UUID-only. Both new and legacy public origins are allowed content hosts, neither may access management endpoints or inherit management credentials. Download widgets on the new manager allow exactly the two configured public ancestors. Editor preview/base handling uses each record's correct public URL. Unknown hosts remain rejected.

The old manager's browser GET/HEAD navigation redirects to the new manager with path/query preserved; legacy `/view/` navigation still points to the old public origin for UUIDs. Unsafe methods on the old manager are rejected instead of replaying credentials across hosts. Keep old published download-frame URLs functional through safe navigation to the new widget.

## Deployment

Update checked-in production constants, deployment environment examples, health probes, Nginx and supported Vercel routing together. Preserve existing unrelated Nginx hosts and Certbot TLS blocks. Snapshot and restore all modified configuration in the deployment transaction. Migrate only the two origin values in the existing management environment while preserving credentials and unrelated fields. Content environment stays credential-free. Rollback health probes must use the previous environment's management hostname.

DNS and TLS for `desk.wekkii.cn` and `ho.wekkii.cn` must be ready before activation; the current services remain unchanged until then. At preflight neither new name resolved on the production host. The user was asked to point both A records to `163.7.4.158`. Never claim deployment completion from local tests alone.

## Acceptance

Test code format, collision retry/exhaustion, concurrent allocation, malformed mappings, no code reuse, legacy identity preservation, HTML/ZIP replacement, rollback, route/host isolation, download widget ancestors and deployment rollback. Run full Node checks and browser editor workflows. After approved DNS/TLS readiness, deploy the immutable commit and verify HTTPS, source-version agreement, temporary new upload/short link/edit/rollback/delete, and read-only access to an existing old URL. Delete only temporary test records.
