import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { isAuthorizedRequest } from "../lib/auth.mjs";
import {
  assertRecordId,
  assertUploadFile,
  buildReplacementPackageRecord,
  buildReplacementRecord,
  getUploadKind,
  publicRecords
} from "../lib/records.mjs";
import {
  deleteObsoleteUploadFiles,
  deleteUpload,
  getRecord,
  restorePreviousVersion,
  savePackageUpload,
  savePreviousVersion,
  saveRecord,
  saveUpload
} from "../lib/storage.mjs";
import { parseZipWebsite } from "../lib/zip.mjs";

export async function DELETE(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("Please enter the access password first", 401);
    }
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("Upload record does not exist", 404);
    }

    await deleteUpload(record);
    return json({ ok: true });
  } catch (requestError) {
    return error(requestError.message || "Delete failed", requestError.status || 500);
  }
}

export async function PUT(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("Please enter the access password first", 401);
    }
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("Upload record does not exist", 404);
    }

    const form = await request.formData();
    const file = form.get("file");
    const originalName = assertUploadFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const previousVersion = await savePreviousVersion(record);
    const recordWithPrevious = {
      ...record,
      previousVersion
    };

    let updatedRecord;
    if (getUploadKind(originalName) === "zip") {
      const packageData = parseZipWebsite(fileBuffer);
      const { packageBlob, siteFiles } = await savePackageUpload(record.id, fileBuffer, packageData.files, {
        allowOverwrite: true
      });
      updatedRecord = buildReplacementPackageRecord({
        record: recordWithPrevious,
        indexBuffer: packageData.indexHtml,
        originalName,
        packageBlob,
        siteFiles,
        sourceSize: fileBuffer.length
      });
    } else {
      const uploadBlob = await saveUpload(record.id, fileBuffer, { allowOverwrite: true });
      updatedRecord = buildReplacementRecord({
        record: recordWithPrevious,
        fileBuffer,
        originalName,
        uploadBlob
      });
    }

    const savedRecord = await saveRecord(updatedRecord);
    await deleteObsoleteUploadFiles(record, savedRecord);
    return json({ record: publicRecords([savedRecord])[0] });
  } catch (requestError) {
    return error(requestError.message || "Replace failed", requestError.status || 500);
  }
}

export async function PATCH(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("Please enter the access password first", 401);
    }
    const id = new URL(request.url).searchParams.get("id");
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) {
      return error("Upload record does not exist", 404);
    }

    const restored = await restorePreviousVersion(record);
    return json({ record: publicRecords([restored])[0] });
  } catch (requestError) {
    return error(requestError.message || "Rollback failed", requestError.status || 500);
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
    if (request.method === "PATCH") {
      return PATCH(request);
    }
    return methodNotAllowed();
  }
};
