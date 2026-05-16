import { error } from "../lib/http.mjs";
import { assertRecordId } from "../lib/records.mjs";
import { getRecord, getUploadContent } from "../lib/storage.mjs";

export async function GET(request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("HTML 页面不存在", 404);
    }

    const upload = await getUploadContent(record);
    if (!upload) {
      return error("HTML 文件已丢失", 404);
    }

    const headers = {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    };
    if (upload.contentLength) {
      headers["Content-Length"] = String(upload.contentLength);
    }
    return new Response(upload.body, { status: 200, headers });
  } catch (requestError) {
    return error(requestError.message || "页面读取失败", requestError.status || 500);
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return GET(request);
    }
    return error("请求方法不支持", 405);
  }
};
