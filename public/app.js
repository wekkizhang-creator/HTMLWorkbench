const state = {
  records: [],
  selectedFile: null,
  latestRecord: null
};

const elements = {
  clearButton: document.querySelector("#clearButton"),
  copyLatestButton: document.querySelector("#copyLatestButton"),
  dropzone: document.querySelector("#dropzone"),
  emptyState: document.querySelector("#emptyState"),
  fileDetail: document.querySelector("#fileDetail"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  latestLink: document.querySelector("#latestLink"),
  latestTime: document.querySelector("#latestTime"),
  linkStatus: document.querySelector("#linkStatus"),
  openLatestButton: document.querySelector("#openLatestButton"),
  originText: document.querySelector("#originText"),
  recordBody: document.querySelector("#recordBody"),
  refreshButton: document.querySelector("#refreshButton"),
  toast: document.querySelector("#toast"),
  totalCount: document.querySelector("#totalCount"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadForm: document.querySelector("#uploadForm"),
  uploadStatus: document.querySelector("#uploadStatus")
};

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

function icon(name) {
  const icons = {
    copy: '<rect x="8" y="8" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h9a1 1 0 0 1 1 1v1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    external: '<path d="M14 4h6v6M10 14 20 4M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7l1-4h4l1 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
}

function absoluteUrl(url) {
  return new URL(url, window.location.origin).href;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  return dateFormatter.format(new Date(value));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2400);
}

function setSelectedFile(file) {
  state.selectedFile = file || null;
  elements.uploadButton.disabled = !state.selectedFile;

  if (!state.selectedFile) {
    elements.fileName.textContent = "选择 HTML 文件";
    elements.fileDetail.textContent = ".html / .htm，最大 10 MB";
    elements.uploadStatus.textContent = "待选择";
    elements.uploadStatus.classList.remove("ready");
    elements.fileInput.value = "";
    return;
  }

  elements.fileName.textContent = state.selectedFile.name;
  elements.fileDetail.textContent = formatBytes(state.selectedFile.size);
  elements.uploadStatus.textContent = "已选择";
  elements.uploadStatus.classList.add("ready");
}

function setLatestRecord(record) {
  state.latestRecord = record || null;
  const hasRecord = Boolean(state.latestRecord);
  const link = hasRecord ? absoluteUrl(state.latestRecord.url) : "#";

  elements.latestLink.href = link;
  elements.latestLink.textContent = hasRecord ? link : "--";
  elements.copyLatestButton.disabled = !hasRecord;
  elements.openLatestButton.href = link;
  elements.openLatestButton.classList.toggle("disabled", !hasRecord);
  elements.linkStatus.textContent = hasRecord ? "已生成" : "等待上传";
}

function renderStats() {
  elements.totalCount.textContent = state.records.length;
  elements.latestTime.textContent = state.records.length ? formatDate(state.records[0].uploadedAt) : "--";
  elements.originText.textContent = window.location.origin;
}

function renderRecords() {
  elements.recordBody.innerHTML = "";
  elements.emptyState.classList.toggle("visible", state.records.length === 0);

  for (const record of state.records) {
    const link = absoluteUrl(record.url);
    const row = document.createElement("tr");
    row.dataset.id = record.id;
    row.innerHTML = `
      <td>
        <div class="file-stack">
          <strong title="${escapeHtml(record.originalName)}">${escapeHtml(record.originalName)}</strong>
          <span>${record.id.slice(0, 8)}</span>
        </div>
      </td>
      <td>${escapeHtml(record.title || record.originalName)}</td>
      <td>${formatDate(record.uploadedAt)}</td>
      <td>${formatBytes(record.size || 0)}</td>
      <td>
        <div class="link-stack">
          <a href="${link}" target="_blank" rel="noopener" title="${link}">${link}</a>
          <span>${escapeHtml(record.url)}</span>
        </div>
      </td>
      <td>
        <div class="row-actions">
          <button class="button secondary" type="button" data-action="copy" data-url="${link}">${icon("copy")}复制</button>
          <a class="button secondary" href="${link}" target="_blank" rel="noopener">${icon("external")}打开</a>
          <button class="button secondary danger" type="button" data-action="delete">${icon("trash")}删除</button>
        </div>
      </td>
    `;
    elements.recordBody.appendChild(row);
  }

  renderStats();
  setLatestRecord(state.records[0] || null);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

async function loadRecords() {
  const payload = await api("/api/uploads");
  state.records = payload.records || [];
  renderRecords();
}

async function uploadSelectedFile() {
  if (!state.selectedFile) {
    return;
  }

  const formData = new FormData();
  formData.append("file", state.selectedFile);
  elements.uploadButton.disabled = true;
  elements.uploadButton.textContent = "发布中";

  try {
    const payload = await api("/api/uploads", {
      method: "POST",
      body: formData
    });
    state.records = [payload.record, ...state.records];
    setSelectedFile(null);
    renderRecords();
    setLatestRecord(payload.record);
    showToast("HTML 链接已生成");
  } finally {
    elements.uploadButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0-12 4 4m-4-4-4 4M5 15v4h14v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>发布';
    elements.uploadButton.disabled = !state.selectedFile;
  }
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function deleteRecord(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record || !window.confirm(`删除 ${record.originalName}？`)) {
    return;
  }

  await api(`/api/uploads/${id}`, { method: "DELETE" });
  state.records = state.records.filter((item) => item.id !== id);
  renderRecords();
  showToast("记录已删除");
}

function handleFiles(files) {
  const file = files && files[0];
  if (!file) {
    return;
  }

  const extension = file.name.split(".").pop().toLowerCase();
  if (extension !== "html" && extension !== "htm") {
    showToast("请选择 .html 或 .htm 文件");
    return;
  }
  setSelectedFile(file);
}

elements.fileInput.addEventListener("change", () => {
  handleFiles(elements.fileInput.files);
});

elements.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await uploadSelectedFile();
  } catch (error) {
    showToast(error.message);
    elements.uploadButton.disabled = !state.selectedFile;
  }
});

elements.clearButton.addEventListener("click", () => {
  setSelectedFile(null);
});

elements.refreshButton.addEventListener("click", async () => {
  try {
    await loadRecords();
    showToast("记录已刷新");
  } catch (error) {
    showToast(error.message);
  }
});

elements.copyLatestButton.addEventListener("click", async () => {
  if (!state.latestRecord) {
    return;
  }
  await copyText(absoluteUrl(state.latestRecord.url));
  showToast("链接已复制");
});

elements.recordBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const row = event.target.closest("tr");
  const action = button.dataset.action;
  try {
    if (action === "copy") {
      await copyText(button.dataset.url);
      showToast("链接已复制");
    }
    if (action === "delete") {
      await deleteRecord(row.dataset.id);
    }
  } catch (error) {
    showToast(error.message);
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.add("drag-over");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("drag-over");
  });
}

elements.dropzone.addEventListener("drop", (event) => {
  handleFiles(event.dataTransfer.files);
});

loadRecords().catch((error) => {
  showToast(error.message);
});
