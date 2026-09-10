import { createHash } from "node:crypto";

export function assertEditableRecord(record) {
  if (!record) throw statusError("Upload record does not exist", 404);
  if ((record.uploadKind || "html") !== "html") {
    throw statusError("ZIP packages cannot be edited", 409);
  }
  return record;
}

export function createEditorVersion(record, buffer) {
  return `"${createHash("sha256")
    .update(String(record.id))
    .update("\0")
    .update(String(record.uploadedAt || ""))
    .update("\0")
    .update(buffer)
    .digest("hex")}"`;
}

function statusError(message, status) {
  const requestError = new Error(message);
  requestError.status = status;
  return requestError;
}
