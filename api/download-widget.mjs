import { error } from "../lib/http.mjs";
import { assertRecordId } from "../lib/records.mjs";
import { getRuntimeConfig } from "../lib/runtime.mjs";

export async function GET(request) {
  try {
    const requestUrl = new URL(request.url);
    const id = requestUrl.searchParams.get("id") || requestUrl.pathname.split("/").filter(Boolean).pop();
    assertRecordId(id);

    const { adminOrigin, publicOrigin } = getRuntimeConfig();
    return new Response(buildWidgetHtml(id, adminOrigin), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${publicOrigin}`,
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (requestError) {
    return error(requestError.message || "Download widget is unavailable", requestError.status || 500);
  }
}

function buildWidgetHtml(id, adminOrigin) {
  const downloadUrl = new URL(`/api/download?id=${encodeURIComponent(id)}`, adminOrigin).href;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <form id="html-workbench-download-form">
    <label>Download password <input id="html-workbench-download-password" type="password" inputmode="numeric" autocomplete="off" required></label>
    <button type="submit">Download</button>
    <output id="html-workbench-download-message" aria-live="polite"></output>
  </form>
  <script>
    (() => {
      const form = document.getElementById("html-workbench-download-form");
      const input = document.getElementById("html-workbench-download-password");
      const message = document.getElementById("html-workbench-download-message");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        message.textContent = "";
        const response = await fetch(${JSON.stringify(downloadUrl)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value })
        });
        if (!response.ok) {
          message.textContent = "Download password is incorrect";
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "download";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      });
    })();
  </script>
</body>
</html>`;
}

export default {
  async fetch(request) {
    if (request.method === "GET") return GET(request);
    return error("Method not allowed", 405);
  }
};
