# Task 4 Report: Storage Index Maintenance, Pagination, and Migration

## Snapshot

- Base SHA: `bf6f6ba53d41a99b6f3c71001d4fabe605efb6d3`
- Implementation SHA: `2ae5304cec98ff377bea71ffe0cb4c000f66f11f`
- Branch: `codex/public-origin-pagination`

## TDD Evidence

RED was recorded before production edits:

```text
node --test tests/record-pagination.test.mjs tests/record-index-migration.test.mjs
tests 12, pass 4, fail 8
```

The expected failures were missing `listRecordsPage`, `saveIndexedRecord`, and
`migrateRecordIndex`, absent migration scripts, and upload mutation routes still using
`saveRecord`. A separate Blob contract RED run failed 1/1 because
`listRecordsPage` did not exist.

Focused GREEN after the minimal implementation:

```text
node --test tests/record-pagination.test.mjs tests/record-index-migration.test.mjs tests/storage-streaming.test.mjs
tests 16, pass 16, fail 0
```

Full-suite GREEN:

```text
npm.cmd test
tests 75, pass 75, fail 0
```

## Files

- `lib/storage.mjs`: indexed record writes/deletes, ready gating, local and Blob pagination,
  bounded index reads, and idempotent migration.
- `api/uploads.mjs`: paged GET plus indexed HTML/ZIP upload writes.
- `api/delete-upload.mjs`: indexed replacement writes; rollback and delete remain routed
  through storage lifecycle helpers.
- `scripts/migrate-record-index.mjs`: live and `--dry-run` migration CLI.
- `package.json`: live and dry-run migration scripts.
- `tests/record-pagination.test.mjs`: 1205-record traversal, sparse filters, Blob scan
  limits, 503 readiness, and replace/rollback/delete maintenance.
- `tests/record-index-migration.test.mjs`: missing/damaged/orphan repair, dry-run, and rerun
  idempotency.

## Migration Behavior

- Canonical `records/` entries are consumed through all Blob SDK cursors or all local
  files; migration does not stop at 1000.
- Missing expected indexes increment `created`; malformed or stale expected indexes and
  orphan indexes increment `repaired`; exact indexes increment `skipped`.
- Dry-run reports the same planned counts without writing indexes, deleting orphans, or
  writing the ready marker.
- A completed non-dry run writes `record-index-state/v1-ready.json` only when `failed` is
  zero. The test fixture's first repair run reports `3 scanned / 1 created / 2 repaired /
  1 skipped / 0 failed`; its second run reports `3 scanned / 0 created / 0 repaired /
  3 skipped / 0 failed`.
- Existing canonical records without the marker return status 503 and code
  `record_index_not_ready`. A fresh empty store initializes the marker after its first
  successful indexed write.

## Self-Review

- New canonical record and index writes complete before a prior timestamp index is
  removed, leaving migration able to repair any interrupted multi-object operation.
- Blob page scans call `list()` with exactly the current page's remaining match count,
  consume every returned index document with concurrency capped at 12, and retain the SDK
  cursor only after the complete batch is consumed.
- Local cursors store the last consumed filename and resume at the next lexical filename,
  so a deleted prior index does not restart or skip the page.
- Index documents continue to contain public record fields only. Download isolation,
  public-origin routing, and streaming code were not changed; their existing tests passed.
- `git diff --check` completed without whitespace errors before the implementation commit.

## Attention Items

- Run `npm.cmd run migrate:record-index:dry-run` and then
  `npm.cmd run migrate:record-index` against every existing deployment before serving the
  paged list. Until migration completes, the intentional response is 503.
- Blob pagination was verified with a deterministic SDK contract test, not live Blob
  credentials. Production migration should be monitored for permission or network failures;
  any nonzero `failed` count leaves the ready marker unwritten.
