import { publicRecord } from "./records.mjs";
import { getRecordPath, RECORD_INDEX_PREFIX } from "./constants.mjs";

const REVERSE_TIMESTAMP_MAX = 9_999_999_999_999_999n;

function invalidTimestamp() {
  const error = new Error("Record uploadedAt must be a finite timestamp at or after the Unix epoch and encode to 16 digits");
  error.status = 400;
  error.code = "invalid_record_timestamp";
  return error;
}

function reverseTimestamp(uploadedAt) {
  const timestamp = Date.parse(String(uploadedAt || ""));
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw invalidTimestamp();
  }
  const encoded = (REVERSE_TIMESTAMP_MAX - BigInt(timestamp)).toString().padStart(16, "0");
  if (encoded.length !== 16) {
    throw invalidTimestamp();
  }
  return encoded;
}

function normalizedFilter(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

export function buildRecordIndexPath(record) {
  return `${RECORD_INDEX_PREFIX}${reverseTimestamp(record.uploadedAt)}-${record.id}.json`;
}

export function buildRecordIndexDocument(record) {
  return {
    indexPath: buildRecordIndexPath(record),
    recordPath: record.recordPath || getRecordPath(record.id),
    record: publicRecord(record)
  };
}

export function matchesRecord(record, filters = {}) {
  const documentType = String(filters.documentType || "").trim();
  if (documentType && String(record.documentType || "").trim() !== documentType) {
    return false;
  }

  const query = normalizedFilter(filters.query);
  if (!query) {
    return true;
  }

  return [record.title, record.description, record.originalName, record.documentType]
    .map((value) => normalizedFilter(value))
    .some((value) => value.includes(query));
}
