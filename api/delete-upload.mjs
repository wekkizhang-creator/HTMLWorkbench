import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { isAuthorizedRequest } from "../lib/auth.mjs";
import { assertHtmlFile, assertRecordId, buildReplacementRecord, publicRecords } from "../lib/records.mjs";
import { deleteUpload, getRecord, saveRecord, saveUpload } from "../lib/storage.mjs";

export async function DELETE(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("请先输入访问密码", 401);
    }
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

export async function PUT(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("请先输入访问密码", 401);
    }
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("上传记录不存在", 404);
    }

    const form = await request.formData();
    const file = form.get("file");
    const originalName = assertHtmlFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const uploadBlob = await saveUpload(record.id, fileBuffer, { allowOverwrite: true });
    const updatedRecord = await saveRecord(buildReplacementRecord({
      record,
      fileBuffer,
      originalName,
      uploadBlob
    }));

    return json({ record: publicRecords([updatedRecord])[0] });
  } catch (requestError) {
    return error(requestError.message || "替换失败", requestError.status || 500);
  }
}

export default {
  async fetch(request) {
    if (request.method === "DELETE") {
      return DELETE(request);
    }
    if (request.method === "PUT") {
      return PUT(request);
    }
    return methodNotAllowed();
  }
};
