import { verifyPassword } from "../lib/auth.mjs";
import { error } from "../lib/http.mjs";
import { assertRecordId, getSafeFileName } from "../lib/records.mjs";
import { getDownloadContent, getRecord } from "../lib/storage.mjs";

export async function POST(request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);

    const body = await request.json().catch(() => ({}));
    if (!verifyPassword(body.password)) {
      return error("密码不正确", 401);
    }

    const record = await getRecord(id);
    if (!record) {
      return error("上传记录不存在", 404);
    }

    const upload = await getDownloadContent(record);
    if (!upload) {
      return error("上传文件已丢失", 404);
    }

    const defaultName = record.uploadKind === "zip" ? `${record.id}.zip` : `${record.id}.html`;
    const fileName = getSafeFileName(record.originalName || defaultName);
    const headers = {
      "Cache-Control": "no-store",
      "Content-Disposition": buildContentDisposition(fileName),
      "Content-Type": upload.contentType || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    };
    if (upload.contentLength) {
      headers["Content-Length"] = String(upload.contentLength);
    }

    return new Response(upload.body, { status: 200, headers });
  } catch (requestError) {
    return error(requestError.message || "下载失败", requestError.status || 500);
  }
}

function buildContentDisposition(fileName) {
  const fallbackName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export default {
  async fetch(request) {
    if (request.method === "POST") {
      return POST(request);
    }
    return error("请求方法不支持", 405);
  }
};
