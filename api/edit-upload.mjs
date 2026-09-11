import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { managementRequestFailure } from "../lib/auth.mjs";
import { MAX_UPLOAD_BYTES } from "../lib/constants.mjs";
import { assertEditableRecord, createEditorVersion } from "../lib/editor-content.mjs";
import { assertRecordId, buildReplacementRecord, publicRecord } from "../lib/records.mjs";
import {
  getRecord,
  getUploadContent,
  saveIndexedRecord,
  savePreviousVersion,
  saveUpload,
  withRecordMutation
} from "../lib/storage.mjs";

export async function GET(request) {
  try {
    const failure = await managementRequestFailure(request, { requireCsrf: false, allowSameOriginGet: true });
    if (failure) return error(failure.message, failure.status);

    const { htmlBuffer, record } = await getEditableContent(request);
    const version = createEditorVersion(record, htmlBuffer);
    return json({
      html: htmlBuffer.toString("utf8"),
      record: publicRecord(record),
      version
    }, 200, { ETag: version });
  } catch (requestError) {
    return error(requestError.message || "Failed to read editor source", requestError.status || 500);
  }
}

export async function PUT(request) {
  try {
    const failure = await managementRequestFailure(request);
    if (failure) return error(failure.message, failure.status);
    assertHtmlContentType(request.headers.get("content-type"));
    const ifMatch = request.headers.get("if-match");
    if (!ifMatch) throw statusError("If-Match is required", 428);

    const htmlBuffer = Buffer.from(await request.arrayBuffer());
    if (htmlBuffer.length === 0) throw statusError("Edited HTML cannot be empty", 400);
    if (htmlBuffer.length > MAX_UPLOAD_BYTES) throw statusError("Edited HTML exceeds the 30 MB limit", 413);

    return await withRecordMutation(async () => {
      const { record, htmlBuffer: currentBuffer } = await getEditableContent(request);
      if (ifMatch !== createEditorVersion(record, currentBuffer)) {
        return error("The HTML source changed before it could be saved", 409);
      }

      const previousVersion = await savePreviousVersion(record);
      const uploadBlob = await saveUpload(record.id, htmlBuffer, { allowOverwrite: true });
      const updatedRecord = buildReplacementRecord({
        record: { ...record, previousVersion },
        fileBuffer: htmlBuffer,
        originalName: record.originalName,
        title: record.title,
        uploadBlob
      });
      const savedRecord = await saveIndexedRecord(updatedRecord, record);
      return json({
        record: publicRecord(savedRecord),
        version: createEditorVersion(savedRecord, htmlBuffer)
      });
    });
  } catch (requestError) {
    return error(requestError.message || "Failed to save editor source", requestError.status || 500);
  }
}

async function getEditableContent(request) {
  const id = new URL(request.url).searchParams.get("id");
  assertRecordId(id);
  const record = assertEditableRecord(await getRecord(id));
  const upload = await getUploadContent(record);
  if (!upload) throw statusError("Current HTML file is missing", 404);
  return {
    htmlBuffer: Buffer.from(await new Response(upload.body).arrayBuffer()),
    record
  };
}

function assertHtmlContentType(contentType) {
  if (String(contentType || "").split(";", 1)[0].trim().toLowerCase() !== "text/html") {
    throw statusError("Edited source must use text/html", 415);
  }
}

function statusError(message, status) {
  const requestError = new Error(message);
  requestError.status = status;
  return requestError;
}

export default {
  async fetch(request) {
    if (request.method === "GET") return GET(request);
    if (request.method === "PUT") return PUT(request);
    return methodNotAllowed();
  }
};
