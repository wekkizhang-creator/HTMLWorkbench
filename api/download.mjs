import { isAdminHostRequest, verifyDownloadPassword } from "../lib/auth.mjs";
import { error } from "../lib/http.mjs";
import { assertRecordId, getSafeFileName } from "../lib/records.mjs";
import { getRuntimeConfig } from "../lib/runtime.mjs";
import { getDownloadContent, getRecord } from "../lib/storage.mjs";

export function isTrustedAdminOrigin(request) {
  return request.headers.get("origin") === getRuntimeConfig().adminOrigin;
}

export async function POST(request) {
  try {
    if (!isAdminHostRequest(request)) {
      return error("Page does not exist", 404);
    }
    if (!isTrustedAdminOrigin(request)) {
      return error("Download requests must come from the admin origin", 403);
    }

    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);

    const body = await request.json().catch(() => ({}));
    if (!verifyDownloadPassword(body.password)) {
      return error("Download password is incorrect", 401);
    }

    const record = await getRecord(id);
    if (!record) {
      return error("Upload record does not exist", 404);
    }

    const upload = await getDownloadContent(record);
    if (!upload) {
      return error("Upload file is missing", 404);
    }

    const defaultName = record.uploadKind === "zip" ? `${record.id}.zip` : `${record.id}.html`;
    const fileName = getSafeFileName(record.originalName || defaultName);
    const headers = {
      "Cache-Control": "no-store",
      "Content-Disposition": buildContentDisposition(fileName),
      "Content-Type": upload.contentType || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    };
    if (upload.contentLength) headers["Content-Length"] = String(upload.contentLength);

    return new Response(upload.body, { status: 200, headers });
  } catch (requestError) {
    return error(requestError.message || "Download failed", requestError.status || 500);
  }
}

function buildContentDisposition(fileName) {
  const fallbackName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export default {
  async fetch(request) {
    if (request.method === "POST") return POST(request);
    return error("Method not allowed", 405);
  }
};