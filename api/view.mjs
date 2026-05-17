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

    const body = injectDownloadWidget(await new Response(upload.body).text(), record);
    const headers = {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    };
    return new Response(body, { status: 200, headers });
  } catch (requestError) {
    return error(requestError.message || "页面读取失败", requestError.status || 500);
  }
}

function injectDownloadWidget(html, record) {
  if (html.includes("html-workbench-download-root")) {
    return html;
  }

  const widget = buildDownloadWidget(record);
  const closingBody = html.match(/<\/body\s*>/i);
  if (!closingBody || closingBody.index === undefined) {
    return `${html}${widget}`;
  }
  return `${html.slice(0, closingBody.index)}${widget}${html.slice(closingBody.index)}`;
}

function buildDownloadWidget(record) {
  const recordId = JSON.stringify(record.id);
  const fileName = JSON.stringify(record.originalName || "download.html");
  return `
<div id="html-workbench-download-root" aria-live="polite">
  <style>
    #html-workbench-download-root {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 2147483647;
      font-family: Inter, "Microsoft YaHei", "PingFang SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #061a1d;
    }
    #html-workbench-download-root * {
      box-sizing: border-box;
    }
    #html-workbench-download-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 46px;
      padding: 0 16px;
      border: 1px solid rgba(255, 255, 255, 0.74);
      border-radius: 999px;
      color: #ffffff;
      background: linear-gradient(135deg, #007f72, #10a6ff);
      box-shadow: 0 18px 48px rgba(0, 127, 114, 0.28);
      font: inherit;
      font-weight: 760;
      cursor: pointer;
    }
    #html-workbench-download-button svg {
      width: 18px;
      height: 18px;
    }
    #html-workbench-download-panel[hidden] {
      display: none;
    }
    #html-workbench-download-panel {
      position: absolute;
      right: 0;
      bottom: 58px;
      width: min(320px, calc(100vw - 32px));
      padding: 14px;
      border: 1px solid rgba(93, 124, 132, 0.26);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.94);
      box-shadow: 0 22px 70px rgba(20, 48, 58, 0.22);
      backdrop-filter: blur(16px);
    }
    #html-workbench-download-panel strong {
      display: block;
      margin-bottom: 10px;
      font-size: 15px;
      line-height: 1.25;
    }
    #html-workbench-download-panel input {
      width: 100%;
      min-height: 40px;
      margin-bottom: 10px;
      padding: 0 11px;
      border: 1px solid rgba(93, 124, 132, 0.3);
      border-radius: 8px;
      color: #061a1d;
      background: #ffffff;
      font: inherit;
      outline: 0;
    }
    #html-workbench-download-panel input:focus {
      border-color: #00b894;
      box-shadow: 0 0 0 3px rgba(0, 184, 148, 0.14);
    }
    #html-workbench-download-actions {
      display: flex;
      gap: 8px;
    }
    #html-workbench-download-actions button {
      flex: 1;
      min-height: 38px;
      border: 1px solid rgba(93, 124, 132, 0.24);
      border-radius: 8px;
      background: #ffffff;
      color: #061a1d;
      font: inherit;
      font-weight: 720;
      cursor: pointer;
    }
    #html-workbench-download-actions button[type="submit"] {
      border-color: transparent;
      color: #ffffff;
      background: linear-gradient(135deg, #007f72, #10a6ff);
    }
    #html-workbench-download-message {
      min-height: 18px;
      margin-top: 9px;
      color: #c53f52;
      font-size: 12px;
      line-height: 1.4;
    }
  </style>
  <button id="html-workbench-download-button" type="button" aria-haspopup="dialog">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    下载
  </button>
  <form id="html-workbench-download-panel" hidden>
    <strong>输入密码下载 HTML</strong>
    <input id="html-workbench-download-password" type="password" inputmode="numeric" autocomplete="off" placeholder="访问密码">
    <div id="html-workbench-download-actions">
      <button type="button" id="html-workbench-download-cancel">取消</button>
      <button type="submit">下载</button>
    </div>
    <div id="html-workbench-download-message"></div>
  </form>
  <script>
    (() => {
      const recordId = ${recordId};
      const fileName = ${fileName};
      const root = document.getElementById("html-workbench-download-root");
      const button = document.getElementById("html-workbench-download-button");
      const panel = document.getElementById("html-workbench-download-panel");
      const input = document.getElementById("html-workbench-download-password");
      const cancel = document.getElementById("html-workbench-download-cancel");
      const message = document.getElementById("html-workbench-download-message");

      const closePanel = () => {
        panel.hidden = true;
        input.value = "";
        message.textContent = "";
      };

      button.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          input.focus();
        }
      });

      cancel.addEventListener("click", closePanel);

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !panel.hidden) {
          closePanel();
        }
      });

      panel.addEventListener("submit", async (event) => {
        event.preventDefault();
        message.textContent = "";
        const submit = panel.querySelector('button[type="submit"]');
        submit.disabled = true;
        submit.textContent = "验证中";
        try {
          const response = await fetch("/api/download?id=" + encodeURIComponent(recordId), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: input.value })
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || "密码验证失败");
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = fileName || "download.html";
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          closePanel();
        } catch (error) {
          message.textContent = error.message || "下载失败";
        } finally {
          submit.disabled = false;
          submit.textContent = "下载";
        }
      });
    })();
  </script>
</div>`;
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return GET(request);
    }
    return error("请求方法不支持", 405);
  }
};
