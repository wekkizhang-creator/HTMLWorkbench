import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecordIndexDocument,
  buildRecordIndexPath,
  matchesRecord
} from "../lib/record-index.mjs";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

test("reverse timestamp index paths sort newest first", () => {
  const older = buildRecordIndexPath({ id: ID_A, uploadedAt: "2026-01-01T00:00:00.000Z" });
  const newer = buildRecordIndexPath({ id: ID_B, uploadedAt: "2026-07-24T00:00:00.000Z" });

  assert.ok(newer.localeCompare(older) < 0);
  assert.match(newer, /^record-index\/v1\/\d{16}-[0-9a-f-]{36}\.json$/i);
});

test("index documents contain only public record fields", () => {
  const record = {
    id: ID_A,
    originalName: "report.html",
    title: "Quarterly Report",
    description: "A searchable report",
    documentType: "Analysis",
    uploadKind: "html",
    size: 42,
    uploadedAt: "2026-07-24T00:00:00.000Z",
    blobPath: "uploads/secret.html",
    blobUrl: "https://blob.example/secret",
    recordPath: `records/${ID_A}.json`
  };
  const document = buildRecordIndexDocument(record);

  assert.equal(document.indexPath, buildRecordIndexPath(record));
  assert.equal(document.recordPath, `records/${ID_A}.json`);
  assert.equal(document.record.blobPath, undefined);
  assert.equal(document.record.blobUrl, undefined);
  assert.equal(document.record.title, record.title);
});

test("record filters search public text and document type", () => {
  const record = {
    id: ID_A,
    originalName: "Quarterly-Report.html",
    title: "Revenue Overview",
    description: "A searchable report",
    documentType: "Analysis"
  };

  assert.equal(matchesRecord(record, { query: "report", documentType: "" }), true);
  assert.equal(matchesRecord(record, { query: "missing", documentType: "" }), false);
  assert.equal(matchesRecord(record, { query: "", documentType: "Analysis" }), true);
  assert.equal(matchesRecord(record, { query: "", documentType: "Prototype" }), false);
});

test("pre-epoch timestamps are rejected and epoch indexes stay 16 digits", () => {
  const epochPath = buildRecordIndexPath({ id: ID_A, uploadedAt: "1970-01-01T00:00:00.000Z" });
  const timestamp = epochPath.match(/^record-index\/v1\/(\d+)-/);
  assert.equal(timestamp?.[1].length, 16);

  assert.throws(
    () => buildRecordIndexPath({ id: ID_A, uploadedAt: "1969-12-31T23:59:59.999Z" }),
    (error) => error.status === 400 && /timestamp/i.test(error.message)
  );
});
