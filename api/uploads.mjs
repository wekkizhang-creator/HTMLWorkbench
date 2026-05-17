import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { isAuthorizedRequest } from "../lib/auth.mjs";
import { assertHtmlFile, buildRecord, normalizeDocumentType, publicRecords } from "../lib/records.mjs";
import { listRecords, saveRecord, saveUpload } from "../lib/storage.mjs";

export async function GET(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("请先输入访问密码", 401);
    }
    const records = await listRecords();
    return json({ records: publicRecords(records) });
  } catch (requestError) {
    return error(requestError.message || "读取上传记录失败", requestError.status || 500);
  }
}

export async function POST(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("请先输入访问密码", 401);
    }
    const form = await request.formData();
    const file = form.get("file");
    const documentType = normalizeDocumentType(form.get("documentType"));
    const originalName = assertHtmlFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const temporaryRecord = buildRecord({
      fileBuffer,
      originalName,
      documentType,
      uploadBlob: {
        pathname: "",
        url: ""
      }
    });
    const uploadBlob = await saveUpload(temporaryRecord.id, fileBuffer);
    const record = await saveRecord({
      ...temporaryRecord,
      blobPath: uploadBlob.pathname,
      blobUrl: uploadBlob.url
    });

    return json({ record: publicRecords([record])[0] }, 201);
  } catch (requestError) {
    return error(requestError.message || "上传失败", requestError.status || 500);
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return GET(request);
    }
    if (request.method === "POST") {
      return POST(request);
    }
    return methodNotAllowed();
  }
};
