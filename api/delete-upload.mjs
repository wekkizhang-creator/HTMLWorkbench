import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { assertRecordId } from "../lib/records.mjs";
import { deleteUpload, getRecord } from "../lib/storage.mjs";

export async function DELETE(request) {
  try {
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("上传记录不存在", 404);
    }

    await deleteUpload(record);
    return json({ ok: true });
  } catch (requestError) {
    return error(requestError.message || "删除失败", requestError.status || 500);
  }
}

export default {
  async fetch(request) {
    if (request.method === "DELETE") {
      return DELETE(request);
    }
    return methodNotAllowed();
  }
};
