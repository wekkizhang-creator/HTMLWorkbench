export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const UPLOAD_PREFIX = "uploads/";
export const RECORD_PREFIX = "records/";

export const HTML_EXTENSIONS = new Set(["html", "htm"]);

export function getUploadPath(id) {
  return `${UPLOAD_PREFIX}${id}.html`;
}

export function getRecordPath(id) {
  return `${RECORD_PREFIX}${id}.json`;
}
