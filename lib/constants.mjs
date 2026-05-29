export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const UPLOAD_PREFIX = "uploads/";
export const RECORD_PREFIX = "records/";
export const MAX_ZIP_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 300;

export const HTML_EXTENSIONS = new Set(["html", "htm"]);
export const ZIP_EXTENSIONS = new Set(["zip"]);
export const UPLOAD_EXTENSIONS = new Set([...HTML_EXTENSIONS, ...ZIP_EXTENSIONS]);

export function getUploadPath(id) {
  return `${UPLOAD_PREFIX}${id}.html`;
}

export function getPackageSourcePath(id) {
  return `${UPLOAD_PREFIX}${id}/package.zip`;
}

export function getSiteFilePath(id, pathname) {
  return `${UPLOAD_PREFIX}${id}/site/${pathname}`;
}

export function getPreviousUploadPath(id) {
  return `${UPLOAD_PREFIX}${id}/previous/upload.html`;
}

export function getPreviousPackageSourcePath(id) {
  return `${UPLOAD_PREFIX}${id}/previous/package.zip`;
}

export function getPreviousSiteFilePath(id, pathname) {
  return `${UPLOAD_PREFIX}${id}/previous/site/${pathname}`;
}

export function getRecordPath(id) {
  return `${RECORD_PREFIX}${id}.json`;
}
