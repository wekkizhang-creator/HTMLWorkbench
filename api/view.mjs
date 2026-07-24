import { error } from "../lib/http.mjs";
import { assertRecordId } from "../lib/records.mjs";
import { getRuntimeConfig } from "../lib/runtime.mjs";
import { getRecord, getSiteFileContent, getUploadContent } from "../lib/storage.mjs";

export async function GET(request) {
  try {
    const requestUrl = new URL(request.url);
    const id = requestUrl.searchParams.get("id");
    const assetPath = requestUrl.searchParams.get("path") || "";
    assertRecordId(id);
    const record = await getRecord(id);
    if (!record) return error("HTML page does not exist", 404);

    if (assetPath) {
      if (record.uploadKind !== "zip") return error("ZIP asset does not exist", 404);
      const asset = await getSiteFileContent(record, assetPath);
      if (!asset) return error("ZIP asset does not exist", 404);
      if (String(asset.contentType || "").startsWith("text/html")) {
        const html = await new Response(asset.body).text();
        return htmlResponse(injectDownloadFrame(injectPackageBase(html, record), record));
      }
      const headers = {
        "Cache-Control": "public, max-age=60",
        "Content-Type": asset.contentType || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      };
      if (asset.contentLength) headers["Content-Length"] = String(asset.contentLength);
      return new Response(asset.body, { status: 200, headers });
    }

    const upload = await getUploadContent(record);
    if (!upload) return error("HTML file is missing", 404);

    const html = await new Response(upload.body).text();
    const body = injectDownloadFrame(record.uploadKind === "zip" ? injectPackageBase(html, record) : html, record);
    return htmlResponse(body);
  } catch (requestError) {
    return error(requestError.message || "Failed to read page", requestError.status || 500);
  }
}

function htmlResponse(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function injectPackageBase(html, record) {
  if (/<base\s/i.test(html)) return html;
  const baseTag = `<base href="/view/${record.id}/">`;
  const head = html.match(/<head[^>]*>/i);
  if (!head || head.index === undefined) return `${baseTag}${html}`;
  const insertAt = head.index + head[0].length;
  return `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`;
}

function injectDownloadFrame(html, record) {
  if (html.includes("html-workbench-download-frame")) return html;
  const widgetUrl = new URL(`/public-download-widget/${encodeURIComponent(record.id)}`, getRuntimeConfig().adminOrigin).href;
  const frame = `<iframe class="html-workbench-download-frame" src="${widgetUrl}" title="Download current file" sandbox="allow-forms allow-scripts allow-downloads allow-same-origin"></iframe>`;
  const closingBody = html.match(/<\/body\s*>/i);
  if (!closingBody || closingBody.index === undefined) return `${html}${frame}`;
  return `${html.slice(0, closingBody.index)}${frame}${html.slice(closingBody.index)}`;
}

export default {
  async fetch(request) {
    if (request.method === "GET") return GET(request);
    return error("Method not allowed", 405);
  }
};