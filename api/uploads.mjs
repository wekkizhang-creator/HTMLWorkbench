import { error, json, methodNotAllowed } from "../lib/http.mjs";
import { isAuthorizedRequest } from "../lib/auth.mjs";
import {
  assertUploadFile,
  buildPackageRecord,
  buildRecord,
  getUploadKind,
  normalizeDocumentType,
  publicRecords
} from "../lib/records.mjs";
import { listRecords, savePackageUpload, saveRecord, saveUpload } from "../lib/storage.mjs";
import { parseZipWebsite } from "../lib/zip.mjs";

export async function GET(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("Please enter the access password first", 401);
    }
    const records = await listRecords();
    return json({ records: publicRecords(records) });
  } catch (requestError) {
    return error(requestError.message || "Failed to read upload records", requestError.status || 500);
  }
}

export async function POST(request) {
  try {
    if (!isAuthorizedRequest(request)) {
      return error("Please enter the access password first", 401);
    }
    const form = await request.formData();
    const file = form.get("file");
    const documentType = normalizeDocumentType(form.get("documentType"));
    const originalName = assertUploadFile(file);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    if (getUploadKind(originalName) === "zip") {
      const packageData = parseZipWebsite(fileBuffer);
      const temporaryRecord = buildPackageRecord({
        documentType,
        indexBuffer: packageData.indexHtml,
        originalName,
        packageBlob: {
          pathname: "",
          url: ""
        },
        siteFiles: [],
        sourceSize: fileBuffer.length
      });
      const { packageBlob, siteFiles } = await savePackageUpload(
        temporaryRecord.id,
        fileBuffer,
        packageData.files
      );
      const record = await saveRecord({
        ...temporaryRecord,
        sourceBlobPath: packageBlob.pathname,
        sourceBlobUrl: packageBlob.url,
        siteFiles
      });
      return json({ record: publicRecords([record])[0] }, 201);
    }

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
    return error(requestError.message || "Upload failed", requestError.status || 500);
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
