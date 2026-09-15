export const PUBLIC_VIEW_RE = /^\/view\/([0-9a-fA-F-]{36}|[A-Za-z0-9]{10})(?:\/(.*))?$/;
const PUBLIC_TOKEN_RE = /^(?:[0-9a-fA-F-]{36}|[A-Za-z0-9]{10})$/;

export function isPublicToken(value) {
  return typeof value === "string" && PUBLIC_TOKEN_RE.test(value);
}

export function publicViewPath(record, kind = record.uploadKind) {
  return `/view/${record.publicCode || record.id}${kind === "zip" ? "/" : ""}`;
}
