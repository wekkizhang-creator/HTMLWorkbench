const state = {
  activeDocumentType: "",
  records: [],
  searchQuery: "",
  selectedFile: null,
  latestRecord: null,
  hasLoadedRecords: false,
  recordsLoading: false,
  uploadLoading: false,
  uploadPhase: "idle",
  nextCursor: null,
  hasMore: false,
  activeQueryKey: "",
  requestController: null,
  mutationEpoch: 0,
  pendingReplacementPagination: null,
  csrfToken: ""
};

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const RECORDS_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 200;
const UPLOAD_REQUEST_TIMEOUT_MS = 60 * 1000;
let searchDebounceTimer;
let uploadPhaseTimer;
const DEFAULT_DOCUMENT_TYPE = "其他";
const BASE_DOCUMENT_TYPES = ["分析报告", "原型", "其他"];

const elements = {
  clearButton: document.querySelector("#clearButton"),
  copyLatestButton: document.querySelector("#copyLatestButton"),
  documentTypeCustom: document.querySelector("#documentTypeCustom"),
  documentTypeSelect: document.querySelector("#documentTypeSelect"),
  dropzone: document.querySelector("#dropzone"),
  emptyState: document.querySelector("#emptyState"),
  emptyText: document.querySelector("#emptyText"),
  fileDetail: document.querySelector("#fileDetail"),
  fileInput: document.querySelector("#fileInput"),
  fileName: document.querySelector("#fileName"),
  latestLink: document.querySelector("#latestLink"),
  latestTime: document.querySelector("#latestTime"),
  linkStatus: document.querySelector("#linkStatus"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  logoutButton: document.querySelector("#logoutButton"),
  openLatestButton: document.querySelector("#openLatestButton"),
  originText: document.querySelector("#originText"),
  recordBody: document.querySelector("#recordBody"),
  recordsError: document.querySelector("#recordsError"),
  recordsErrorMessage: document.querySelector("#recordsErrorMessage"),
  recordsLoading: document.querySelector("#recordsLoading"),
  recordsSkeleton: document.querySelector("#recordsSkeleton"),
  recordsPanel: document.querySelector("#recordsPanel"),
  refreshButton: document.querySelector("#refreshButton"),
  retryButton: document.querySelector("#retryButton"),
  searchInput: document.querySelector("#searchInput"),
  titleInput: document.querySelector("#titleInput"),
  toast: document.querySelector("#toast"),
  totalCount: document.querySelector("#totalCount"),
  typeFilter: document.querySelector("#typeFilter"),
  uploadButton: document.querySelector("#uploadButton"),
  uploadButtonLabel: document.querySelector("#uploadButtonLabel"),
  uploadForm: document.querySelector("#uploadForm"),
  uploadProgress: document.querySelector("#uploadProgress"),
  uploadProgressBar: document.querySelector("#uploadProgressBar"),
  uploadProgressLabel: document.querySelector("#uploadProgressLabel"),
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
    replace: '<path d="M17 3v5h-5M7 21v-5h5M17 8a7 7 0 0 0-11.6-2.7M7 16a7 7 0 0 0 11.6 2.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    rollback: '<path d="M9 14 4 9l5-5M5 9h8a7 7 0 1 1-5.3 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
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

function normalizeDocumentType(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  return normalized || DEFAULT_DOCUMENT_TYPE;
}

function getDocumentTypes() {
  const seen = new Set();
  const types = [];
  for (const type of [
    ...BASE_DOCUMENT_TYPES,
    state.activeDocumentType,
    ...state.records.map((record) => record.documentType)
  ]) {
    const normalized = normalizeDocumentType(type);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    types.push(normalized);
  }
  return types;
}

function setCustomTypeVisible(shouldFocus = false) {
  const isCustom = elements.documentTypeSelect.value === "__custom";
  const customField = elements.documentTypeCustom.closest(".field-control");
  customField.hidden = !isCustom;
  customField.closest(".upload-meta-grid").classList.toggle("custom-type-visible", isCustom);
  if (isCustom && shouldFocus) {
    elements.documentTypeCustom.focus();
  }
}

function getSelectedDocumentType() {
  if (elements.documentTypeSelect.value === "__custom") {
    return normalizeDocumentType(elements.documentTypeCustom.value);
  }
  return normalizeDocumentType(elements.documentTypeSelect.value);
}

function renderDocumentTypeOptions() {
  const types = getDocumentTypes();
  const uploadSelection = elements.documentTypeSelect.value;
  const customSelected = uploadSelection === "__custom";

  if (state.activeDocumentType && !types.includes(state.activeDocumentType)) {
    state.activeDocumentType = "";
  }

  elements.documentTypeSelect.innerHTML = [
    ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`),
    '<option value="__custom">新建类型</option>'
  ].join("");
  elements.documentTypeSelect.value = customSelected || !types.includes(uploadSelection)
    ? customSelected ? "__custom" : DEFAULT_DOCUMENT_TYPE
    : uploadSelection;
  setCustomTypeVisible();

  elements.typeFilter.innerHTML = [
    '<option value="">全部类型</option>',
    ...types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`)
  ].join("");
  elements.typeFilter.value = state.activeDocumentType;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("visible");
  }, 2400);
}

function redirectToLogin() {
  window.location.href = `/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}

function setRecordsLoading(isLoading) {
  state.recordsLoading = isLoading;
  elements.recordsPanel.setAttribute("aria-busy", String(isLoading));
  elements.refreshButton.disabled = isLoading;
  elements.refreshButton.classList.toggle("is-loading", isLoading);
  elements.loadMoreButton.disabled = isLoading || !state.hasMore;
  if (state.hasMore) {
    elements.loadMoreButton.textContent = isLoading ? "加载中" : "加载更多";
  }
  elements.recordsLoading.hidden = !(isLoading && !state.hasLoadedRecords);
  elements.recordsSkeleton.hidden = !isLoading;
  if (isLoading) {
    elements.recordsError.hidden = true;
  }
}

function showRecordsLoadError(message) {
  if (state.hasLoadedRecords) {
    showToast(message);
    return;
  }
  elements.recordsLoading.hidden = true;
  elements.recordsError.hidden = false;
  elements.recordsErrorMessage.textContent = message || "请检查网络后重试";
}

function uploadPhaseLabel(phase, progress) {
  if (phase === "uploading") {
    return Number.isFinite(progress)
      ? "\u6b63\u5728\u4e0a\u4f20 " + Math.round(progress) + "%"
      : "\u6b63\u5728\u4e0a\u4f20\u6587\u4ef6";
  }
  const labels = {
    idle: "",
    processing: "\u6587\u4ef6\u4f20\u8f93\u5b8c\u6210\uff0c\u6b63\u5728\u5904\u7406",
    success: "\u53d1\u5e03\u5b8c\u6210",
    error: "\u53d1\u5e03\u5931\u8d25"
  };
  return labels[phase] || "";
}

function setUploadPhase(phase, progress) {
  window.clearTimeout(uploadPhaseTimer);
  state.uploadPhase = phase;
  const label = uploadPhaseLabel(phase, progress);
  const isIndeterminate = phase === "processing"
    || phase === "error"
    || (phase === "uploading" && !Number.isFinite(progress));
  const hasValue = phase === "success" || (phase === "uploading" && Number.isFinite(progress));

  elements.uploadProgress.hidden = phase === "idle";
  elements.uploadProgress.dataset.phase = phase;
  elements.uploadProgressLabel.textContent = label;
  elements.uploadProgressBar.toggleAttribute("data-indeterminate", isIndeterminate);

  if (hasValue) {
    const value = phase === "success" ? 100 : Math.min(100, Math.max(0, progress));
    elements.uploadProgressBar.value = value;
    elements.uploadProgressBar.setAttribute("value", String(value));
    elements.uploadProgressBar.setAttribute("aria-valuenow", String(Math.round(value)));
    elements.uploadProgressBar.removeAttribute("aria-valuetext");
    return;
  }

  elements.uploadProgressBar.removeAttribute("value");
  elements.uploadProgressBar.removeAttribute("aria-valuenow");
  elements.uploadProgressBar.setAttribute("aria-valuetext", label);
}

function resetUploadPhaseSoon() {
  window.clearTimeout(uploadPhaseTimer);
  uploadPhaseTimer = window.setTimeout(() => setUploadPhase("idle"), 1600);
}

function setUploadLoading(isLoading) {
  state.uploadLoading = isLoading;
  elements.uploadForm.setAttribute("aria-busy", String(isLoading));
  elements.uploadButton.disabled = isLoading || !state.selectedFile;
  elements.uploadButton.classList.toggle("is-loading", isLoading);
  elements.uploadButtonLabel.textContent = isLoading ? "\u6b63\u5728\u53d1\u5e03" : "\u53d1\u5e03";
  elements.uploadStatus.textContent = isLoading ? "\u53d1\u5e03\u4e2d" : state.selectedFile ? "\u5df2\u9009\u62e9" : "\u5f85\u9009\u62e9";
}

function setSelectedFile(file) {
  state.selectedFile = file || null;
  elements.uploadButton.disabled = !state.selectedFile || state.uploadLoading;

  if (!state.selectedFile) {
    elements.fileName.textContent = "选择 HTML 或 ZIP 文件";
    elements.fileDetail.textContent = ".html / .htm / .zip，最大 30 MB";
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

function getRecordQueryKey() {
  return JSON.stringify([
    state.searchQuery.trim(),
    state.activeDocumentType
  ]);
}

function snapshotPaginationForReplacement(queryKey) {
  if (state.pendingReplacementPagination?.queryKey === queryKey) {
    return state.pendingReplacementPagination;
  }
  if (state.activeQueryKey === queryKey && state.hasMore && state.nextCursor) {
    return {
      queryKey,
      nextCursor: state.nextCursor,
      hasMore: state.hasMore
    };
  }
  return null;
}

function resetPagination(queryKey, replacementPagination) {
  state.requestController?.abort();
  state.nextCursor = null;
  state.hasMore = false;
  state.activeQueryKey = queryKey;
  state.pendingReplacementPagination = replacementPagination;
}

function invalidateRecordRequestsAfterMutation() {
  state.mutationEpoch += 1;
  state.requestController?.abort();
  state.nextCursor = null;
  state.hasMore = false;
  state.pendingReplacementPagination = null;
}

function deduplicateById(records) {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function setRecordCollection(records) {
  state.records = records;
  renderDocumentTypeOptions();
}

function renderRecords({ enteringRecordIds = [], successRecordId = null } = {}) {
  const enteringIds = new Set(enteringRecordIds);
  const visibleRecords = state.records;
  elements.recordBody.innerHTML = "";
  elements.emptyState.classList.toggle("visible", visibleRecords.length === 0);
  elements.loadMoreButton.hidden = !state.hasMore;
  elements.loadMoreButton.disabled = state.recordsLoading || !state.hasMore;
  elements.loadMoreButton.textContent = state.recordsLoading ? "加载中" : "加载更多";
  elements.emptyText.textContent = "暂无记录";

  for (const record of visibleRecords) {
    const link = absoluteUrl(record.url);
    const row = document.createElement("tr");
    row.className = "record-row";
    row.dataset.id = record.id;
    if (enteringIds.has(record.id)) {
      row.dataset.entering = "true";
    }
    if (successRecordId === record.id) {
      row.classList.add("record-row--success");
    }
    row.innerHTML = `
      <td data-label="文件">
        <div class="file-stack">
          <strong title="${escapeHtml(record.originalName)}">${escapeHtml(record.originalName)}</strong>
          <span>${record.id.slice(0, 8)} · ${(record.uploadKind || "html").toUpperCase()}</span>
        </div>
      </td>
      <td data-label="标题与描述">
        <div class="description-stack">
          <strong>${escapeHtml(record.title || record.originalName)}</strong>
          <span>${escapeHtml(record.description || "暂无描述")}</span>
        </div>
      </td>
      <td data-label="文档类型">
        <span class="type-badge">${escapeHtml(normalizeDocumentType(record.documentType))}</span>
      </td>
      <td data-label="上传时间">${formatDate(record.uploadedAt)}</td>
      <td data-label="大小">${formatBytes(record.size || 0)}</td>
      <td data-label="访问链接">
        <div class="link-stack">
          <a href="${link}" target="_blank" rel="noopener" title="${link}">${link}</a>
          <span>${escapeHtml(record.url)}</span>
        </div>
      </td>
      <td data-label="操作">
        <div class="row-actions">
          <button class="button secondary" type="button" data-action="copy" data-url="${link}">${icon("copy")}复制</button>
          <a class="button secondary" href="${link}" target="_blank" rel="noopener">${icon("external")}打开</a>
          <button class="button secondary" type="button" data-action="replace">${icon("replace")}替换</button>
          <button class="button secondary" type="button" data-action="rollback" ${record.hasPreviousVersion ? "" : "disabled"}>${icon("rollback")}回滚</button>
          <button class="button secondary danger" type="button" data-action="delete">${icon("trash")}删除</button>
        </div>
      </td>
    `;
    elements.recordBody.appendChild(row);
    if (row.dataset.entering === "true" || row.classList.contains("record-row--success")) {
      const clearMotion = () => {
        delete row.dataset.entering;
        row.classList.remove("record-row--success");
      };
      const motionTimer = window.setTimeout(clearMotion, 1200);
      row.addEventListener("animationend", () => {
        window.clearTimeout(motionTimer);
        clearMotion();
      }, { once: true });
    }
  }

  renderStats();
  setLatestRecord(state.records[0] || null);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isWriteMethod(method = "GET") {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

async function api(path, options = {}) {
  let response;
  try {
    const requestOptions = { ...options, headers: new Headers(options.headers || {}) };
    if (isWriteMethod(requestOptions.method)) {
      if (!state.csrfToken) throw new Error("Security token is unavailable; please sign in again");
      requestOptions.headers.set("X-CSRF-Token", state.csrfToken);
    }
    response = await fetch(path, requestOptions);
  } catch {
    throw new Error("网络连接失败，请检查网络后重试");
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    redirectToLogin();
    throw new Error(payload.error || "请先输入访问密码");
  }
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function uploadWithProgress(url, formData, onProgress, method = "POST") {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("X-CSRF-Token", state.csrfToken);
    xhr.responseType = "json";
    xhr.timeout = UPLOAD_REQUEST_TIMEOUT_MS;
    xhr.upload.addEventListener("progress", (event) => {
      onProgress(event.lengthComputable && event.total > 0
        ? (event.loaded / event.total) * 100
        : null);
    });
    xhr.upload.addEventListener("load", () => onProgress(100));
    xhr.addEventListener("error", () => {
      reject(new Error("\u7f51\u7edc\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5"));
    });
    xhr.addEventListener("abort", () => {
      reject(new Error("\u4e0a\u4f20\u5df2\u53d6\u6d88\uff0c\u8bf7\u91cd\u8bd5"));
    });
    xhr.addEventListener("timeout", () => {
      reject(new Error("\u4e0a\u4f20\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5"));
    });
    xhr.addEventListener("load", () => {
      let payload = xhr.response;
      if (!payload || typeof payload !== "object") {
        try {
          payload = JSON.parse(xhr.responseText || "{}");
        } catch {
          payload = {};
        }
      }
      if (xhr.status === 401) {
        redirectToLogin();
        reject(new Error(payload.error || "\u8bf7\u5148\u8f93\u5165\u8bbf\u95ee\u5bc6\u7801"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload.error || "\u8bf7\u6c42\u5931\u8d25"));
        return;
      }
      resolve(payload);
    });
    xhr.send(formData);
  });
}

async function loadRecords({ append = false } = {}) {
  const queryKey = getRecordQueryKey();
  const replacementPagination = append ? null : snapshotPaginationForReplacement(queryKey);
  if (append && (state.recordsLoading || !state.hasMore || !state.nextCursor || state.activeQueryKey !== queryKey)) {
    return false;
  }

  if (!append) {
    resetPagination(queryKey, replacementPagination);
  }

  const cursor = append ? state.nextCursor : null;
  const mutationEpoch = state.mutationEpoch;
  const requestController = new AbortController();
  state.requestController = requestController;
  state.activeQueryKey = queryKey;

  const params = new URLSearchParams();
  params.set("limit", String(RECORDS_PAGE_SIZE));
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (state.searchQuery.trim()) {
    params.set("q", state.searchQuery.trim());
  }
  if (state.activeDocumentType) {
    params.set("documentType", state.activeDocumentType);
  }

  setRecordsLoading(true);
  try {
    const payload = await api(`/api/uploads?${params.toString()}`, {
      signal: requestController.signal
    });
    if (
      state.requestController !== requestController
      || state.activeQueryKey !== queryKey
      || state.mutationEpoch !== mutationEpoch
    ) {
      return false;
    }

    const incomingRecords = payload.records || [];
    const existingRecordIds = new Set(state.records.map((record) => record.id));
    const records = append
      ? deduplicateById([...state.records, ...incomingRecords])
      : incomingRecords;
    const enteringRecordIds = append
      ? incomingRecords.filter((record) => !existingRecordIds.has(record.id)).map((record) => record.id)
      : [];
    setRecordCollection(records);
    state.nextCursor = payload.page?.nextCursor || null;
    state.hasMore = Boolean(payload.page?.hasMore && state.nextCursor);
    state.pendingReplacementPagination = null;
    renderRecords({ enteringRecordIds });
    state.hasLoadedRecords = true;
    return true;
  } catch (error) {
    if (
      state.requestController !== requestController
      || state.activeQueryKey !== queryKey
      || state.mutationEpoch !== mutationEpoch
    ) {
      return false;
    }
    if (!append && replacementPagination?.queryKey === queryKey) {
      state.nextCursor = replacementPagination.nextCursor;
      state.hasMore = replacementPagination.hasMore;
      state.pendingReplacementPagination = null;
      renderRecords();
    }
    showRecordsLoadError(error.message);
    return false;
  } finally {
    if (state.requestController === requestController) {
      setRecordsLoading(false);
    }
  }
}

async function uploadSelectedFile() {
  if (!state.selectedFile) {
    return;
  }

  const formData = new FormData();
  formData.append("file", state.selectedFile);
  formData.append("documentType", getSelectedDocumentType());
  formData.append("title", elements.titleInput.value);
  setUploadLoading(true);
  setUploadPhase("uploading");

  try {
    const payload = await uploadWithProgress("/api/uploads", formData, (progress) => {
      if (progress === 100) {
        setUploadPhase("processing");
        return;
      }
      setUploadPhase("uploading", progress);
    });
    invalidateRecordRequestsAfterMutation();
    setRecordCollection([payload.record, ...state.records]);
    elements.titleInput.value = "";
    setSelectedFile(null);
    renderRecords({ successRecordId: payload.record.id });
    setLatestRecord(payload.record);
    setUploadPhase("success");
    resetUploadPhaseSoon();
    showToast("\u53d1\u5e03\u94fe\u63a5\u5df2\u751f\u6210\uff0c\u63cf\u8ff0\u5df2\u81ea\u52a8\u8865\u5168");
  } catch (error) {
    setUploadPhase("error");
    resetUploadPhaseSoon();
    throw error;
  } finally {
    setUploadLoading(false);
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
  invalidateRecordRequestsAfterMutation();
  setRecordCollection(state.records.filter((item) => item.id !== id));
  renderRecords();
  showToast("记录已删除");
}

function validateHtmlFile(file) {
  if (!file) {
    return false;
  }

  const extension = file.name.split(".").pop().toLowerCase();
  if (!["html", "htm", "zip"].includes(extension)) {
    showToast("请选择 .html、.htm 或 .zip 文件");
    return false;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    showToast("上传限制为 30 MB");
    return false;
  }
  return true;
}

function handleFiles(files) {
  const file = files && files[0];
  if (!validateHtmlFile(file)) {
    return;
  }
  setSelectedFile(file);
}

function chooseReplacementFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    const resolveOnce = (file) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener("focus", handleFocus);
      input.remove();
      resolve(file);
    };
    const handleFocus = () => {
      window.setTimeout(() => {
        if (!input.files || input.files.length === 0) {
          resolveOnce(null);
        }
      }, 250);
    };
    input.type = "file";
    input.accept = ".html,.htm,.zip,text/html,application/zip,application/x-zip-compressed";
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      resolveOnce(file);
    }, { once: true });
    window.addEventListener("focus", handleFocus);
    document.body.appendChild(input);
    input.click();
  });
}

async function replaceRecord(id, button) {
  const record = state.records.find((item) => item.id === id);
  if (!record) {
    return;
  }

  const file = await chooseReplacementFile();
  if (!validateHtmlFile(file)) {
    return;
  }
  if (!window.confirm(`用 ${file.name} 替换 ${record.originalName}？访问链接会保持不变。`)) {
    return;
  }
  const title = window.prompt("输入新标题（留空则自动识别）", "");
  if (title === null) {
    return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("title", title);
  const previousHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = "替换中";
  setUploadLoading(true);
  setUploadPhase("uploading");
  try {
    const payload = await uploadWithProgress("/api/uploads/" + id, formData, (progress) => {
      if (progress === 100) {
        setUploadPhase("processing");
        return;
      }
      setUploadPhase("uploading", progress);
    }, "PUT");
    invalidateRecordRequestsAfterMutation();
    setRecordCollection([payload.record, ...state.records.filter((item) => item.id !== id)]);
    renderRecords({ successRecordId: payload.record.id });
    setLatestRecord(payload.record);
    setUploadPhase("success");
    resetUploadPhaseSoon();
    showToast("\u6587\u4ef6\u5df2\u66ff\u6362\uff0c\u8bbf\u95ee\u94fe\u63a5\u4fdd\u6301\u4e0d\u53d8\uff0c\u53ef\u56de\u6eda\u5230\u4e0a\u4e00\u7248\u672c");
  } catch (error) {
    setUploadPhase("error");
    resetUploadPhaseSoon();
    throw error;
  } finally {
    setUploadLoading(false);
    button.disabled = false;
    button.innerHTML = previousHtml;
  }
}

async function rollbackRecord(id, button) {
  const record = state.records.find((item) => item.id === id);
  if (!record || !record.hasPreviousVersion) {
    showToast("当前记录没有可回滚版本");
    return;
  }
  if (!window.confirm(`回滚 ${record.originalName} 到上一次文件版本？`)) {
    return;
  }

  const previousHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = "回滚中";
  try {
    const payload = await api(`/api/uploads/${id}`, {
      method: "PATCH"
    });
    invalidateRecordRequestsAfterMutation();
    setRecordCollection([payload.record, ...state.records.filter((item) => item.id !== id)]);
    renderRecords();
    setLatestRecord(payload.record);
    showToast("已回滚到上一版本");
  } finally {
    button.disabled = false;
    button.innerHTML = previousHtml;
  }
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
  }
});

elements.clearButton.addEventListener("click", () => {
  elements.titleInput.value = "";
  setSelectedFile(null);
});

elements.refreshButton.addEventListener("click", async () => {
  if (await loadRecords()) {
    showToast("记录已刷新");
  }
});

elements.retryButton.addEventListener("click", () => {
  loadRecords();
});

elements.copyLatestButton.addEventListener("click", async () => {
  if (!state.latestRecord) {
    return;
  }
  await copyText(absoluteUrl(state.latestRecord.url));
  showToast("链接已复制");
});

elements.logoutButton.addEventListener("click", async () => {
  await fetch("/api/auth", {
    method: "DELETE",
    headers: { "X-CSRF-Token": state.csrfToken }
  });
  redirectToLogin();
});

elements.documentTypeSelect.addEventListener("change", () => {
  setCustomTypeVisible(true);
});

elements.searchInput.addEventListener("input", () => {
  window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(() => {
    state.searchQuery = elements.searchInput.value;
    void loadRecords();
  }, SEARCH_DEBOUNCE_MS);
});

elements.typeFilter.addEventListener("change", async () => {
  state.activeDocumentType = elements.typeFilter.value;
  await loadRecords();
});

elements.loadMoreButton.addEventListener("click", async () => {
  await loadRecords({ append: true });
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
    if (action === "replace") {
      await replaceRecord(row.dataset.id, button);
    }
    if (action === "rollback") {
      await rollbackRecord(row.dataset.id, button);
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

async function initialize() {
  const session = await api("/api/auth");
  if (!session.authenticated || !session.csrfToken) {
    redirectToLogin();
    return;
  }
  state.csrfToken = session.csrfToken;
  await loadRecords();
}

void initialize().catch((error) => {
  showToast(error.message);
});
