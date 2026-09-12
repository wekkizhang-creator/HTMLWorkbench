import {
  assignEditorNodeIds, chooseEditableElement, EditorHistory, isProtectedElement,
  labelForElement, scrubEditorArtifacts, serializeDocument
} from "./editor-core.mjs";
import { createPresentation } from "./editor-presentation.mjs";
import { readRasterImage, imageReplacementCommand } from "./editor-images.mjs";
import { createDraftStore } from "./editor-drafts.mjs";

function createSaveRequest(html, version) {
  if (!version) throw new Error("Missing document version; reload before saving.");
  if (new TextEncoder().encode(html).byteLength > 30 * 1024 * 1024) {
    throw new Error("HTML 超过 30 MB，无法保存。请缩减内容后重试。");
  }
  return { method: "PUT", headers: { "Content-Type": "text/html; charset=utf-8", "If-Match": version }, body: html };
}

function previewUrl(value, base) {
  const url = new URL(value, base);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Invalid preview URL");
  return url.href;
}

function createThumbnailCache({ maxEntries = 8, maxBytes = 8 * 1024 * 1024 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const previous = entries.get(key);
    if (previous) bytes -= previous.bytes;
    entries.delete(key);
  };
  return {
    get(key, revision) {
      const entry = entries.get(key);
      if (!entry || entry.revision !== revision) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.html;
    },
    set(key, revision, html) {
      remove(key);
      const size = new TextEncoder().encode(html).byteLength;
      if (size > maxBytes) return;
      entries.set(key, { revision, html, bytes: size });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    },
    delete: remove,
    clear() { entries.clear(); bytes = 0; }
  };
}

function snapshotChildren(element) {
  return [...element.childNodes].map((node) => ({
    node,
    value: node.nodeValue,
    attributes: node.attributes ? [...node.attributes].map((attr) => ({ name: attr.name, value: attr.value, namespace: attr.namespaceURI })) : null,
    children: snapshotChildren(node)
  }));
}

function restoreChildren(element, snapshots) {
  element.replaceChildren(...snapshots.map(({ node }) => node));
  for (const snapshot of snapshots) {
    const { node, value, attributes, children } = snapshot;
    if (attributes) {
      for (const attr of [...node.attributes]) node.removeAttributeNode(attr);
      for (const attr of attributes) node.setAttributeNS(attr.namespace, attr.name, attr.value);
      restoreChildren(node, children);
    } else node.nodeValue = value;
  }
}

function updateRawProperty(raw, property, declaration) {
  // Split only top-level declarations; strings, comments and function bodies may contain semicolons.
  const parts = [];
  let start = 0, quote = "", comment = false, depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i], next = raw[i + 1];
    if (comment) { if (c === "*" && next === "/") { comment = false; i++; } continue; }
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === "/" && next === "*") { comment = true; i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === ";" && depth === 0) { parts.push(raw.slice(start, i + 1)); start = i + 1; }
  }
  parts.push(raw.slice(start));
  const kept = parts.map((part) => {
    const name = part.replace(/\/\*[\s\S]*?\*\//g, "").split(":", 1)[0].trim()
      .replace(/\\([\da-f]{1,6})\s?|\\(.)/gi, (_, hex, char) => hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : char);
    return name.toLowerCase() !== property ? part : (part.match(/^(?:\s|\/\*[\s\S]*?\*\/)*/)?.[0] || "");
  }).join("");
  const tail = kept.replace(/\/\*[\s\S]*?\*\//g, "").trimEnd();
  return kept + (tail && !tail.endsWith(";") ? ";" : "") + declaration;
}

function initializeEditor() {
  const $ = (id) => document.getElementById(id);
  const canvas = $("editorCanvas");
  const controls = [...document.querySelectorAll("[data-style]")];
  const colors = [...document.querySelectorAll("[data-color]")];
  const id = new URLSearchParams(location.search).get("id");
  const endpoint = `/api/uploads/${encodeURIComponent(id || "")}/content`;
  let doc = null;
  let sourceDoc = null;
  let doctype = null;
  let version = "";
  let record = null;
  let selected = null;
  let hovered = null;
  let textSession = null;
  let dirty = false;
  let cssDraft = false;
  let propertyDraft = null;
  let busy = false;
  let generation = 0;
  let mountTimer;
  let frameCleanup = () => {};
  let helperNodes = new Set();
  let refreshAttributes = new Map();
  let shadowModes = new Map();
  let rows = new Map();
  let history = newHistory();
  let presentation = null;
  let notesDraft = false;
  let canvasScale = 1;
  let canvasOffset = { x: 0, y: 0 };
  let thumbnailObserver = null;
  let thumbnailTimers = new Map();
  const thumbnailCache = createThumbnailCache();
  let thumbnailRevisions = [];
  let zoom = "fit";
  let panMode = false;
  let panStart = null;
  let draftStore;
  try { draftStore = createDraftStore(); } catch { draftStore = null; }
  let draftOwner = crypto.randomUUID();
  let draftTimer;
  let draftRevision = 0;
  let draftTimestamp = 0;
  let draftQueue = Promise.resolve();
  let recovery = null;
  let restoredDraft = null;
  let draftActionBusy = false;
  let serverHtml = "";

  function newHistory() {
    return new EditorHistory({ onChange(_state, change) {
      dirty = true;
      const command = change?.command;
      if (presentation && Number.isInteger(command?.pageIndex)) {
        if (command.visual !== false) {
          thumbnailRevisions[command.pageIndex]++;
          thumbnailCache.delete(command.pageIndex);
          scheduleThumbnail(command.pageIndex);
        }
        if (change.action !== "execute") {
          presentation.activate(command.pageIndex);
          selected = editable(command.element) ? command.element : null;
        }
      }
      refresh();
      scheduleDraft();
    } });
  }

  function executeCommand(command, { element = selected, pageIndex = presentation?.index, visual = true } = {}) {
    history.execute({ ...command, element, pageIndex, visual });
  }

  function hasChanges() {
    return dirty || hasPendingChanges();
  }

  function hasPendingChanges() {
    return notesDraft || cssDraft || Boolean(propertyDraft) || Boolean(textSession && textSession.element.innerHTML !== textSession.before);
  }

  function showMessage(value = "") {
    $("message").textContent = value;
    $("message").hidden = !value;
  }

  function updateToolbar() {
    const state = history.getState();
    $("undoButton").disabled = busy || !(state.canUndo || hasPendingChanges());
    $("redoButton").disabled = busy || !state.canRedo || hasPendingChanges();
    $("saveButton").disabled = busy || !doc || !hasChanges();
    $("previewButton").disabled = busy || !record;
    $("exportButton").disabled = busy || !doc;
    $("saveState").dataset.dirty = String(hasChanges());
    $("saveState").textContent = busy ? "正在处理…" : !doc ? "尚未载入" : hasChanges() ? "有未保存更改" : "已同步";
    $("workbench").dataset.busy = String(busy);
    canvas.inert = busy;
    $("styleInspector").disabled = busy || !selected;
    $("styleInspector").hidden = !selected;
    $("parentButton").disabled = busy || !editable(selected?.parentElement);
    $("childButton").disabled = busy || !firstChild(selected);
    $("editTextButton").disabled = busy || !safeTextTarget(selected);
    $("notesEditor").disabled = busy || !presentation?.notesAvailable;
    $("deleteButton").disabled = busy || Boolean(presentation?.slides.includes(selected));
    for (const row of $("slideList").children) row.disabled = busy;
    $("restoreDraftButton").disabled = busy || draftActionBusy || hasChanges() || !recovery || recovery.baseVersion !== version;
    $("exportDraftButton").disabled = busy || draftActionBusy || !recovery;
    $("discardDraftButton").disabled = busy || draftActionBusy || !recovery;
    for (const control of $("viewControls").querySelectorAll("button,input")) control.disabled = busy || !presentation;
    updateZoomButtons();
  }

  function editable(element) {
    return Boolean(element && doc?.body?.contains(element) && (!presentation || presentation.slides[presentation.index].contains(element)) && element.tagName !== "TEMPLATE" && !isProtectedElement(element));
  }

  function firstChild(element) {
    return [...(element?.children || [])].find(editable);
  }

  function outline(element, target) {
    if (!editable(element) || busy || textSession) { target.hidden = true; return; }
    const rect = element.getBoundingClientRect();
    target.hidden = !rect.width || !rect.height;
    Object.assign(target.style, { left: `${canvasOffset.x + rect.left * canvasScale}px`, top: `${canvasOffset.y + rect.top * canvasScale}px`, width: `${rect.width * canvasScale}px`, height: `${rect.height * canvasScale}px` });
  }

  function drawOutlines() {
    outline(selected, $("selectionOutline"));
    outline(hovered === selected ? null : hovered, $("hoverOutline"));
  }

  function renderTree() {
    const fragment = document.createDocumentFragment();
    rows = new Map();
    function visit(parent, depth) {
      for (const element of parent.children) {
        if (!editable(element)) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tree-row";
        row.style.setProperty("--indent", `${8 + Math.min(depth, 8) * 12}px`);
        row.dataset.nodeId = element.getAttribute("data-hwb-editor-id") || "";
        row.setAttribute("aria-current", String(element === selected));
        const label = labelForElement(element);
        row.title = label;
        const span = document.createElement("span");
        span.textContent = label;
        row.append(span);
        row.addEventListener("click", () => { if (select(element, true)) { setDrawer(""); rows.get(element)?.focus(); } });
        rows.set(element, row);
        fragment.append(row);
        visit(element, depth + 1);
      }
    }
    if (presentation) visit(presentation.slides[presentation.index], 0);
    else if (doc?.body) visit(doc.body, 0);
    $("moduleTree").replaceChildren(fragment);
  }

  function renderBreadcrumbs() {
    const fragment = document.createDocumentFragment();
    const path = [];
    for (let element = selected; editable(element); element = element.parentElement) path.unshift(element);
    for (const element of path) {
      const button = document.createElement("button");
      button.textContent = labelForElement(element);
      button.title = button.textContent;
      button.addEventListener("click", () => select(element, true));
      fragment.append(button);
    }
    $("breadcrumbs").replaceChildren(fragment);
  }

  function renderInspector() {
    $("inspectorEmpty").hidden = Boolean(selected);
    $("imagePanel").hidden = selected?.tagName !== "IMG";
    if (!selected) return;
    const computed = canvas.contentWindow.getComputedStyle(selected);
    for (const control of controls) {
      const property = control.dataset.style;
      const inline = selected.style.getPropertyValue(property);
      const effective = computed.getPropertyValue(property);
      control.value = control.tagName === "SELECT" ? inline || effective : inline;
      if (control.tagName === "SELECT" && control.selectedIndex === -1) control.value = "";
      control.placeholder = effective || "继承";
      control.title = `当前: ${effective || "继承"}${inline ? " · 内联" : " · 计算样式"}`;
      control.removeAttribute("aria-invalid");
    }
    for (const control of colors) {
      const value = computed.getPropertyValue(control.dataset.color);
      const context = document.createElement("canvas").getContext("2d", { colorSpace: "srgb" });
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const rgba = context.getImageData(0, 0, 1, 1).data;
      control.value = `#${[...rgba].slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      control.dataset.alpha = String(rgba[3] / 255);
      control.style.opacity = String(Math.max(0.25, rgba[3] / 255));
      control.title = value;
    }
    $("advancedCss").value = selected.getAttribute("style") || "";
    cssDraft = false;
    propertyDraft = null;
  }

  function refresh() {
    if (!editable(selected)) selected = null;
    renderTree();
    renderBreadcrumbs();
    renderInspector();
    $("selectionLabel").textContent = selected ? labelForElement(selected) : "未选择元素";
    updateToolbar();
    drawOutlines();
    if (presentation) {
      $("pageIndicator").textContent = `${presentation.index + 1} / ${presentation.slides.length}`;
      if (!notesDraft) $("notesEditor").value = presentation.getNotes(presentation.index);
      for (const [index, row] of [...$("slideList").children].entries()) row.setAttribute("aria-current", index === presentation.index ? "page" : "false");
    }
  }

  function select(element, scroll = false) {
    if (busy) return false;
    finishNotes();
    finishText();
    if (!commitPropertyDraft()) return false;
    if (cssDraft && !applyAdvancedCss()) return false;
    selected = editable(element) ? element : null;
    refresh();
    rows.get(selected)?.scrollIntoView({ block: "nearest" });
    if (scroll) selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    drawOutlines();
    return true;
  }

  function safeTextTarget(target) {
    for (let element = target; editable(element); element = element.parentElement) {
      if (/^(INPUT|TEXTAREA|SELECT|BUTTON|IFRAME|OBJECT|IMG|VIDEO|AUDIO|SVG|CANVAS|BR|HR)$/.test(element.tagName)) return null;
      if (element.querySelector("template,script,style,link,meta,iframe,object,input,textarea,select,button,img,video,audio,svg,canvas")) return null;
      if (![...element.children].some((child) => /^(DIV|P|SECTION|ARTICLE|UL|OL|LI|TABLE|H[1-6])$/.test(child.tagName))) return element;
    }
    return null;
  }

  function beginText(target) {
    const element = safeTextTarget(target);
    if (!element || !select(element)) return;
    textSession = { element, before: element.innerHTML, nodes: snapshotChildren(element), editable: element.getAttribute("contenteditable") };
    element.setAttribute("contenteditable", "true");
    element.focus({ preventScroll: true });
    drawOutlines();
  }

  function finishText() {
    if (!textSession) return;
    const { element, before, nodes, editable: previous } = textSession;
    textSession = null;
    const after = element.innerHTML;
    if (previous === null) element.removeAttribute("contenteditable");
    else element.setAttribute("contenteditable", previous);
    if (before !== after) {
      const afterNodes = snapshotChildren(element);
      // Reuse actual nodes so earlier style/delete commands still target the restored descendants.
      executeCommand({ undo() { restoreChildren(element, nodes); }, redo() { restoreChildren(element, afterNodes); } }, { element });
    } else updateToolbar();
  }

  function applyStyle(cssText) {
    if (!editable(selected) || busy) return;
    finishText();
    const element = selected;
    const before = element.getAttribute("style");
    if ((before || "") === cssText) { cssDraft = false; updateToolbar(); return; }
    executeCommand({
      undo() { if (before === null) element.removeAttribute("style"); else element.setAttribute("style", before); },
      redo() { element.setAttribute("style", cssText); }
    });
  }

  function applyProperty(property, value, control) {
    if (!selected || busy) return false;
    if (cssDraft && !applyAdvancedCss()) return false;
    const style = document.createElement("div").style;
    if (value && !CSS.supports(property, value)) {
      control?.setAttribute("aria-invalid", "true");
      showMessage(`无效的 ${property} 值：${value}`);
      return false;
    }
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
    propertyDraft = null;
    showMessage();
    applyStyle(updateRawProperty(selected.getAttribute("style") || "", property, style.cssText));
    return true;
  }

  function commitPropertyDraft() {
    if (!propertyDraft) return true;
    const { property, value, control } = propertyDraft;
    return applyProperty(property, value, control);
  }

  function applyAdvancedCss() {
    if (!selected || busy) return false;
    const value = $("advancedCss").value.trim();
    const style = document.createElement("div").style;
    style.cssText = value;
    if (value && !style.length) {
      showMessage("CSS 无效，请使用 property: value; 格式。");
      $("advancedCss").setAttribute("aria-invalid", "true");
      return false;
    }
    $("advancedCss").removeAttribute("aria-invalid");
    cssDraft = false;
    showMessage();
    applyStyle(style.cssText);
    return true;
  }

  function removeSelected() {
    finishText();
    if (!commitPropertyDraft()) return;
    if (cssDraft && !applyAdvancedCss()) return;
    if (!editable(selected) || busy || presentation?.slides.includes(selected)) return;
    const element = selected;
    const parent = element.parentNode;
    const next = element.nextSibling;
    executeCommand({
      undo() { parent.insertBefore(element, next?.parentNode === parent ? next : null); selected = element; },
      redo() { element.remove(); selected = editable(parent) ? parent : null; }
    });
  }

  function navigateHistory(direction) {
    if (busy) return;
    finishNotes();
    finishText();
    if (!commitPropertyDraft()) return;
    if (cssDraft && !applyAdvancedCss()) return;
    history[direction]();
  }

  function keyboard(event) {
    if (event.key === "Escape") {
      const wasText = Boolean(textSession);
      finishText(); setDrawer("");
      if (wasText) { event.preventDefault(); $("editTextButton").focus(); }
      return;
    }
    const drawer = $("workbench").dataset.drawer;
    if (drawer && event.key === "Tab") {
      const panel = $(drawer === "tree" ? "treePanel" : "inspectorPanel");
      const focusable = [...panel.querySelectorAll("button,input,select,textarea,summary,[tabindex]")]
        .filter((el) => !el.matches(":disabled") && el.tabIndex >= 0 && el.getClientRects().length);
      const index = focusable.indexOf(document.activeElement);
      event.preventDefault();
      focusable[(index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
      return;
    }
    const typing = event.target.closest?.("input,textarea,select,[contenteditable='true']");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); save(); return;
    }
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault(); navigateHistory(event.shiftKey ? "redo" : "undo");
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (editable(selected)) { event.preventDefault(); removeSelected(); }
    }
  }

  function setDrawer(name) {
    const previous = $("workbench").dataset.drawer;
    $("workbench").dataset.drawer = name;
    $("treeToggle").setAttribute("aria-expanded", String(name === "tree"));
    $("inspectorToggle").setAttribute("aria-expanded", String(name === "inspector"));
    document.querySelector(".topbar").inert = Boolean(name);
    document.querySelector(".canvas-panel").inert = Boolean(name);
    for (const panelName of ["tree", "inspector"]) {
      const panel = $(panelName === "tree" ? "treePanel" : "inspectorPanel");
      panel.inert = Boolean(name && name !== panelName);
      if (name === panelName) { panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); }
      else { panel.removeAttribute("role"); panel.removeAttribute("aria-modal"); }
    }
    if (name) $(name === "tree" ? "treePanel" : "inspectorPanel").querySelector("button")?.focus();
    else if (previous) $(previous === "tree" ? "treeToggle" : "inspectorToggle").focus();
    fitCanvas();
  }

  function fitCanvas() {
    const viewport = $("canvasViewport");
    const surface = $("canvasSurface");
    $("viewControls").hidden = !presentation;
    if (!presentation) {
      canvasScale = 1;
      canvasOffset = { x: 0, y: 0 };
      canvas.removeAttribute("style");
      surface.removeAttribute("style");
      delete viewport.dataset.zoom;
      delete viewport.dataset.pan;
      return;
    }
    const center = { x: (viewport.scrollLeft + viewport.clientWidth / 2 - canvasOffset.x) / canvasScale, y: (viewport.scrollTop + viewport.clientHeight / 2 - canvasOffset.y) / canvasScale };
    viewport.dataset.zoom = zoom === "fit" ? "fit" : "manual";
    canvasScale = zoom === "fit" ? Math.max(0.01, Math.min(viewport.clientWidth / presentation.width, viewport.clientHeight / presentation.height)) : zoom / 100;
    canvasOffset = { x: Math.max(0, (viewport.clientWidth - presentation.width * canvasScale) / 2), y: Math.max(0, (viewport.clientHeight - presentation.height * canvasScale) / 2) };
    Object.assign(surface.style, { width: `${Math.max(viewport.clientWidth, presentation.width * canvasScale)}px`, height: `${Math.max(viewport.clientHeight, presentation.height * canvasScale)}px` });
    Object.assign(canvas.style, { width: `${presentation.width}px`, height: `${presentation.height}px`, left: `${canvasOffset.x}px`, top: `${canvasOffset.y}px`, transform: `scale(${canvasScale})` });
    viewport.scrollLeft = zoom === "fit" ? 0 : center.x * canvasScale + canvasOffset.x - viewport.clientWidth / 2;
    viewport.scrollTop = zoom === "fit" ? 0 : center.y * canvasScale + canvasOffset.y - viewport.clientHeight / 2;
    $("zoomLevel").value = String(Math.round(canvasScale * 100));
    $("fitCanvasButton").setAttribute("aria-pressed", String(zoom === "fit"));
    for (const holder of $("slideList").querySelectorAll(".slide-thumb")) {
      const frame = holder.querySelector("iframe");
      if (frame) frame.style.transform = `scale(${holder.clientWidth / presentation.width})`;
    }
    drawOutlines();
    updateZoomButtons();
  }

  function updateZoomButtons() {
    $("zoomOutButton").disabled = busy || !presentation || canvasScale <= 0.1;
    $("zoomInButton").disabled = busy || !presentation || canvasScale >= 2;
  }

  function setZoom(value) {
    if (!presentation || busy) return;
    if (value !== "fit" && (!Number.isFinite(Number(value)) || Number(value) < 10 || Number(value) > 200)) {
      $("zoomLevel").value = String(Math.round(canvasScale * 100));
      return;
    }
    zoom = value === "fit" ? value : Number(value);
    if (zoom === "fit") setPan(false);
    fitCanvas();
    updateToolbar();
  }

  function setPan(enabled) {
    if (enabled && (!presentation || busy)) return;
    finishText(); finishNotes();
    panMode = enabled;
    panStart = null;
    $("canvasViewport").dataset.pan = String(enabled);
    delete $("canvasViewport").dataset.dragging;
    $("panButton").setAttribute("aria-pressed", String(enabled));
  }

  function draftUnavailable() {
    $("draftState").textContent = "本地草稿不可用，可导出备份";
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftRevision++;
    if (!doc || !record || !hasChanges()) return;
    $("draftState").textContent = "草稿待保存";
    draftTimer = setTimeout(persistDraft, 750);
  }

  function persistDraft(preparedHtml) {
    clearTimeout(draftTimer);
    if (!doc || !record || !hasChanges()) return draftQueue;
    const current = generation, revision = draftRevision;
    let entry;
    try {
      if (!draftStore) throw new Error("Draft storage unavailable");
      entry = { documentId: id, ownerId: draftOwner, baseVersion: version, html: typeof preparedHtml === "string" ? preparedHtml : serializedHtml(true), title: record.title || "HTML", pageIndex: presentation?.index || 0, updatedAt: Math.max(Date.now(), draftTimestamp + 1) };
      draftTimestamp = entry.updatedAt;
    } catch { draftUnavailable(); return draftQueue; }
    draftQueue = draftQueue.then(() => draftStore.write(entry)).then(() => {
      if (current === generation && revision === draftRevision) $("draftState").textContent = "本地草稿已保存";
    }).catch(() => { if (current === generation) draftUnavailable(); });
    return draftQueue;
  }

  async function checkDrafts(current = generation) {
    try {
      if (!draftStore) throw new Error("Draft storage unavailable");
      const entries = await draftStore.list(id);
      if (current !== generation) return;
      recovery = entries.find(entry => entry.ownerId !== draftOwner && entry.html !== serverHtml) || null;
      $("draftRecovery").hidden = !recovery;
      if (recovery) {
        const time = new Date(recovery.updatedAt).toLocaleString();
        $("draftRecoveryMessage").textContent = recovery.baseVersion === version ? `发现本地草稿 · ${time}` : `本地草稿基于旧版本，仅可导出 · ${time}`;
      }
      updateToolbar();
    } catch { if (current === generation) draftUnavailable(); }
  }

  function exportHtml(html, title) {
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    link.href = url;
    link.download = `${String(title || "HTML").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100)}.html`;
    document.body.append(link);
    link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCurrent() {
    if (!doc || busy) return;
    try { exportHtml(serializedHtml(true), record?.title); }
    catch (error) { showMessage(error.message || "导出失败，请重试。"); }
  }

  function restoreLocalDraft() {
    if (busy || draftActionBusy || hasChanges() || !recovery || recovery.baseVersion !== version) return;
    restoredDraft = recovery;
    recovery = null;
    $("draftRecovery").hidden = true;
    busy = true;
    dirty = true;
    selected = null;
    history = newHistory();
    $("loadState").hidden = false;
    $("loadMessage").textContent = "正在恢复草稿…";
    updateToolbar();
    mount(restoredDraft.html, { restored: true, pageIndex: restoredDraft.pageIndex });
  }

  async function discardLocalDraft() {
    if (!recovery || busy || draftActionBusy) return;
    const entry = recovery;
    draftActionBusy = true;
    updateToolbar();
    try {
      await draftStore.remove(id, entry.ownerId, entry.updatedAt);
      await checkDrafts();
    } catch { draftUnavailable(); }
    finally { draftActionBusy = false; updateToolbar(); }
  }

  async function clearPublishedDrafts() {
    clearTimeout(draftTimer);
    await draftQueue;
    try {
      if (!draftStore) return;
      await draftStore.remove(id, draftOwner);
      if (restoredDraft) await draftStore.remove(id, restoredDraft.ownerId, restoredDraft.updatedAt);
      restoredDraft = null;
      $("draftState").textContent = "";
      recovery = null;
      $("draftRecovery").hidden = true;
    } catch { $("draftState").textContent = "已发布，本地草稿清理失败"; }
  }

  function setPanelView(pages) {
    $("slideList").hidden = !pages || !presentation;
    $("moduleTree").hidden = Boolean(pages && presentation);
    $("pagesTab").setAttribute("aria-selected", String(pages));
    $("modulesTab").setAttribute("aria-selected", String(!pages));
    fitCanvas();
  }

  function drawThumbnail(index) {
    if (!presentation) return;
    const holder = $("slideList").children[index]?.querySelector(".slide-thumb");
    if (!holder || !holder.dataset.visible) return;
    let preview = holder.querySelector("iframe");
    const revision = thumbnailRevisions[index];
    if (preview?.dataset.revision === String(revision)) return;
    if (!preview) {
      preview = document.createElement("iframe");
      preview.setAttribute("sandbox", "");
      preview.setAttribute("aria-hidden", "true");
      preview.tabIndex = -1;
      preview.referrerPolicy = "no-referrer";
      holder.append(preview);
    }
    Object.assign(preview.style, { width: `${presentation.width}px`, height: `${presentation.height}px`, transform: `scale(${holder.clientWidth / presentation.width})` });
    let html = thumbnailCache.get(index, revision);
    if (html === undefined) {
      html = presentation.thumbnailHtml(index);
      thumbnailCache.set(index, revision, html);
    }
    preview.srcdoc = html;
    preview.dataset.revision = String(revision);
  }

  function scheduleThumbnail(index) {
    clearTimeout(thumbnailTimers.get(index));
    thumbnailTimers.set(index, setTimeout(() => { thumbnailTimers.delete(index); drawThumbnail(index); }, 250));
  }

  function renderPages() {
    thumbnailObserver?.disconnect();
    thumbnailCache.clear();
    thumbnailRevisions = presentation?.slides.map(() => 0) || [];
    $("slideList").replaceChildren();
    $("presentationTabs").hidden = !presentation;
    $("pageIndicator").hidden = !presentation;
    $("notesPanel").hidden = !presentation?.notesAvailable;
    $("canvasViewport").dataset.presentation = String(Boolean(presentation));
    setPanelView(Boolean(presentation));
    if (!presentation) return;
    thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const holder = entry.target;
        if (entry.isIntersecting) { holder.dataset.visible = "true"; drawThumbnail(Number(holder.dataset.index)); }
        else { delete holder.dataset.visible; holder.replaceChildren(); }
      }
    }, { root: $("slideList"), rootMargin: "150px" });
    presentation.slides.forEach((slide, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "slide-item";
      row.setAttribute("aria-label", `第 ${index + 1} 页 ${slide.dataset.title || slide.getAttribute("aria-label") || ""}`);
      const holder = document.createElement("span");
      holder.className = "slide-thumb";
      holder.style.aspectRatio = `${presentation.width} / ${presentation.height}`;
      holder.dataset.index = index;
      const caption = document.createElement("span");
      caption.className = "slide-caption";
      caption.textContent = `${index + 1}. ${slide.dataset.title || slide.querySelector("h1,h2")?.textContent || "页面"}`;
      row.append(holder, caption);
      row.addEventListener("click", () => switchPage(index));
      $("slideList").append(row);
      thumbnailObserver.observe(holder);
    });
  }

  function finishNotes() {
    if (!notesDraft || !presentation?.notesAvailable || busy) return;
    const deck = presentation, index = deck.index;
    const before = deck.getNotes(index), after = $("notesEditor").value;
    notesDraft = false;
    if (before !== after) executeCommand({ undo() { deck.setNotes(index, before); }, redo() { deck.setNotes(index, after); } }, { element: null, pageIndex: index, visual: false });
  }

  function switchPage(index) {
    if (busy || !presentation) return;
    finishText();
    finishNotes();
    if (!commitPropertyDraft() || cssDraft && !applyAdvancedCss()) return;
    presentation.activate(index);
    selected = null;
    hovered = null;
    refresh();
    fitCanvas();
    setDrawer("");
    $("slideList").children[index]?.focus({ preventScroll: true });
  }

  async function replaceImage() {
    const file = $("imageFile").files[0];
    $("imageFile").value = "";
    if (!file || selected?.tagName !== "IMG" || busy) return;
    finishText(); finishNotes();
    if (!commitPropertyDraft() || cssDraft && !applyAdvancedCss()) return;
    const image = selected;
    busy = true;
    updateToolbar();
    $("imageStatus").textContent = "正在读取图片…";
    try {
      const data = await readRasterImage(file);
      const command = imageReplacementCommand(image, data);
      try { command.redo(); createSaveRequest(serializedHtml(), version); }
      finally { command.undo(); }
      executeCommand(command, { element: image });
      $("imageStatus").textContent = "图片已替换";
    } catch (error) { $("imageStatus").textContent = error.message; }
    finally { busy = false; refresh(); }
  }

  function attachDocument() {
    frameCleanup();
    const removers = [];
    const on = (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      removers.push(() => target.removeEventListener(type, listener, options));
    };
    const hitTarget = target => target?.tagName === "IMG" ? target : chooseEditableElement(target);
    on(doc, "pointermove", (event) => { hovered = hitTarget(event.target); drawOutlines(); });
    on(doc, "pointerleave", () => { hovered = null; drawOutlines(); });
    on(doc, "pointerdown", (event) => {
      if (!textSession && event.target.closest?.("input,textarea,select,button")) event.preventDefault();
    }, true);
    on(doc, "click", (event) => {
      if (textSession?.element.contains(event.target)) return;
      event.preventDefault();
      select(hitTarget(event.target));
    }, true);
    on(doc, "auxclick", (event) => event.preventDefault(), true);
    on(doc, "dblclick", (event) => { event.preventDefault(); if (!busy) beginText(event.target); }, true);
    on(doc, "submit", (event) => event.preventDefault(), true);
    on(doc, "dragstart", (event) => event.preventDefault(), true);
    on(doc, "drop", (event) => event.preventDefault(), true);
    on(doc, "beforeinput", (event) => { if (busy || !textSession?.element.contains(event.target)) event.preventDefault(); }, true);
    on(doc, "paste", (event) => {
      event.preventDefault();
      if (!textSession || busy) return;
      const text = event.clipboardData?.getData("text/plain") || "";
      // Plain-text insertion keeps clipboard markup and scripts outside the document.
      doc.execCommand("insertText", false, text);
    }, true);
    on(doc, "input", () => { updateToolbar(); scheduleDraft(); }, true);
    on(doc, "focusout", (event) => { if (textSession && !textSession.element.contains(event.relatedTarget)) finishText(); }, true);
    on(doc, "keydown", keyboard, true);
    on(doc, "scroll", drawOutlines, true);
    on(canvas.contentWindow, "resize", drawOutlines);
    const observer = new ResizeObserver(drawOutlines);
    observer.observe(doc.body);
    removers.push(() => observer.disconnect());
    frameCleanup = () => removers.forEach((remove) => remove());
  }

  function releaseDocument() {
    clearTimeout(draftTimer);
    draftRevision++;
    presentation?.dispose();
    presentation = null;
    zoom = "fit";
    panMode = false;
    panStart = null;
    $("panButton").setAttribute("aria-pressed", "false");
    delete $("canvasViewport").dataset.pan;
    delete $("canvasViewport").dataset.dragging;
    notesDraft = false;
    thumbnailObserver?.disconnect();
    for (const timer of thumbnailTimers.values()) clearTimeout(timer);
    thumbnailTimers.clear();
    thumbnailCache.clear();
    $("slideList").replaceChildren();
    frameCleanup();
    frameCleanup = () => {};
    if (doc) scrubEditorArtifacts(doc);
    if (sourceDoc) scrubEditorArtifacts(sourceDoc);
    doc = null;
    sourceDoc = null;
  }

  function mount(html, { restored = false, pageIndex = 0 } = {}) {
    releaseDocument();
    sourceDoc = new DOMParser().parseFromString(html, "text/html");
    if (sourceDoc.querySelectorAll(".stage > .slide").length >= 2) {
      Object.assign(canvas.style, { width: "1440px", height: "810px" });
    } else canvas.removeAttribute("style");
    doctype = sourceDoc.doctype?.cloneNode() || null;
    assignEditorNodeIds(sourceDoc);
    // Keep declarative shadow content opaque instead of letting srcdoc consume its templates.
    shadowModes = new Map();
    for (const template of sourceDoc.querySelectorAll("template[shadowrootmode]")) {
      shadowModes.set(template.getAttribute("data-hwb-editor-node-key"), template.getAttribute("shadowrootmode"));
      template.setAttribute("shadowrootmode", "editor-inert");
    }
    const helperToken = crypto.randomUUID();
    refreshAttributes = new Map();
    for (const meta of sourceDoc.querySelectorAll("meta[http-equiv]")) {
      if (meta.getAttribute("http-equiv").toLowerCase() === "refresh") {
        refreshAttributes.set(meta.getAttribute("data-hwb-editor-node-key"), meta.getAttribute("http-equiv"));
        meta.removeAttribute("http-equiv");
      }
    }
    for (const element of sourceDoc.querySelectorAll("[contenteditable]")) element.setAttribute("contenteditable", "false");
    const policy = sourceDoc.createElement("meta");
    policy.setAttribute("http-equiv", "Content-Security-Policy");
    policy.content = "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";
    policy.dataset.editorHelper = helperToken;
    sourceDoc.head.prepend(policy);
    {
      const base = sourceDoc.createElement("base");
      const publicBase = previewUrl(record.url, location.href);
      const originalBase = sourceDoc.querySelector("base[href]");
      base.href = originalBase ? new URL(originalBase.getAttribute("href"), publicBase).href : publicBase;
      base.dataset.editorHelper = helperToken;
      // Resolve before resources and uploaded CSP base-uri restrictions are parsed.
      sourceDoc.head.prepend(base);
    }
    canvas.onload = () => {
      clearTimeout(mountTimer);
      try {
        const mounted = canvas.contentDocument;
        if (!mounted?.body || !mounted.documentElement.hasAttribute("data-hwb-editor-state")) throw new Error("画布导航已停止，请重新载入。");
        doc = mounted;
        presentation = createPresentation(doc);
        if (presentation) presentation.activate(Math.min(pageIndex, presentation.slides.length - 1));
        renderPages();
        fitCanvas();
        helperNodes = new Set(doc.querySelectorAll(`[data-editor-helper="${helperToken}"]`));
        // Keep the source state alive: its keys also identify nodes in srcdoc and history snapshots.
        attachDocument();
        busy = false;
        $("loadState").hidden = true;
        refresh();
        if (restored) {
          $("documentSize").textContent = `${(new TextEncoder().encode(html).byteLength / 1024).toFixed(1)} KB`;
          scheduleDraft();
        }
      } catch (error) { loadFailure(error); }
    };
    canvas.srcdoc = `${doctype ? new XMLSerializer().serializeToString(doctype) : ""}\n${sourceDoc.documentElement.outerHTML}`;
    mountTimer = setTimeout(() => loadFailure(new Error("画布载入超时，请重试。")), 20000);
  }

  function serializedHtml(includePending = false) {
    const clone = doc.cloneNode(true);
    const originals = [doc.documentElement, ...doc.documentElement.querySelectorAll("*")];
    const copies = [clone.documentElement, ...clone.documentElement.querySelectorAll("*")];
    originals.forEach((element, index) => {
      if (helperNodes.has(element)) copies[index].remove();
      const refresh = refreshAttributes.get(element.getAttribute("data-hwb-editor-node-key"));
      if (refresh) copies[index].setAttribute("http-equiv", refresh);
      const mode = shadowModes.get(element.getAttribute("data-hwb-editor-node-key"));
      if (mode !== undefined) copies[index].setAttribute("shadowrootmode", mode);
    });
    if (includePending) {
      const target = copies[originals.indexOf(selected)];
      if (target && cssDraft) {
        const style = document.createElement("div").style;
        const text = $("advancedCss").value.trim();
        style.cssText = text;
        if (!text || style.length) target.setAttribute("style", style.cssText);
      }
      if (target && propertyDraft) {
        const { property, value } = propertyDraft;
        if (!value || CSS.supports(property, value)) {
          const style = document.createElement("div").style;
          if (value) style.setProperty(property, value);
          target.setAttribute("style", updateRawProperty(target.getAttribute("style") || "", property, style.cssText));
        }
      }
      if (notesDraft && presentation?.notesAvailable) {
        const node = clone.querySelector("script#notes-data");
        const notes = JSON.parse(node.textContent);
        notes[presentation.index] = $("notesEditor").value;
        node.textContent = JSON.stringify(notes).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
      }
    }
    presentation?.restoreClone(clone);
    return serializeDocument(clone, doctype);
  }

  function loginRedirect() {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
  }

  async function responsePayload(response) {
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (response.status === 401) {
      if (!hasChanges()) loginRedirect();
      throw new Error("登录已过期。请在新标签页登录发布台，然后重试保存；当前更改仍保留。");
    }
    if (response.status === 409) throw new Error(doc ? "版本冲突：页面已被更新。当前更改仍保留，请先备份编辑内容，再重新载入。" : payload.error || "此文档不支持编辑。");
    if (response.status === 413) throw new Error("HTML 超过 30 MB，无法保存。请缩减内容后重试。");
    if (response.status === 404) throw new Error("文档不存在或已被删除。");
    if (response.status === 415) throw new Error("仅支持单个 HTML 文件，ZIP 包无法编辑。");
    throw new Error(payload.error || "请求失败，请重试。");
  }

  async function fetchSession() {
    const response = await fetch("/api/auth", { cache: "no-store", signal: AbortSignal.timeout(30000) });
    const session = await responsePayload(response);
    if (!session.authenticated || !session.csrfToken) {
      if (!hasChanges()) loginRedirect();
      throw new Error("登录已过期。请在新标签页登录发布台，然后重试；当前更改仍保留。");
    }
    return session.csrfToken;
  }

  function loadFailure(error) {
    clearTimeout(mountTimer);
    busy = false;
    $("loadState").hidden = false;
    $("loadMessage").textContent = error.message;
    $("retryButton").hidden = false;
    updateToolbar();
  }

  async function load() {
    if (busy) return;
    if (hasChanges() && !confirm("重新载入会丢失未保存更改，继续？")) return;
    if (!id) { loadFailure(new Error("缺少文档 ID，请从发布台打开文档。")); return; }
    if (hasChanges()) persistDraft();
    const current = ++generation;
    draftOwner = crypto.randomUUID();
    restoredDraft = null;
    recovery = null;
    $("draftRecovery").hidden = true;
    $("draftState").textContent = "";
    busy = true;
    dirty = false;
    cssDraft = false;
    propertyDraft = null;
    textSession = null;
    selected = null;
    record = null;
    history = newHistory();
    showMessage();
    $("loadState").hidden = false;
    $("loadMessage").textContent = "正在载入文档…";
    $("retryButton").hidden = true;
    updateToolbar();
    try {
      await fetchSession();
      const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(30000) });
      const payload = await responsePayload(response);
      if (current !== generation) return;
      if (typeof payload.html !== "string" || !payload.record || !payload.version) throw new Error("服务器返回了不完整的文档。");
      if ((payload.record.uploadKind || "html") !== "html") throw new Error("仅支持单个 HTML 文件，ZIP 包无法编辑。");
      createSaveRequest(payload.html, payload.version);
      record = payload.record;
      serverHtml = payload.html;
      version = response.headers.get("ETag") || payload.version;
      $("documentTitle").textContent = record.title || record.originalName || "未命名 HTML";
      document.title = `${$("documentTitle").textContent} · HTML 编辑器`;
      $("documentSize").textContent = `${(new TextEncoder().encode(payload.html).byteLength / 1024).toFixed(1)} KB`;
      mount(payload.html);
      checkDrafts(current);
    } catch (error) { if (current === generation) loadFailure(error); }
  }

  async function save() {
    if (busy || !doc) return;
    finishText();
    finishNotes();
    if (!commitPropertyDraft()) return;
    if (cssDraft && !applyAdvancedCss()) return;
    if (!hasChanges()) return;
    showMessage();
    try {
      const html = serializedHtml();
      const options = createSaveRequest(html, version);
      persistDraft(html);
      busy = true;
      updateToolbar();
      options.headers["X-CSRF-Token"] = await fetchSession();
      const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(60000) });
      const payload = await responsePayload(response);
      if (!payload.version || !payload.record) throw new Error("保存响应不完整，请确认服务器状态后重试。");
      record = payload.record;
      version = response.headers.get("ETag") || payload.version;
      serverHtml = html;
      dirty = false;
      history = newHistory();
      await clearPublishedDrafts();
      $("documentSize").textContent = `${(new TextEncoder().encode(html).byteLength / 1024).toFixed(1)} KB`;
      showMessage("已保存并发布。");
    } catch (error) { showMessage(error.message || "保存失败，当前更改仍保留。"); }
    finally { busy = false; updateToolbar(); drawOutlines(); if (hasChanges()) persistDraft(); }
  }

  controls.forEach((control) => control.addEventListener("change", () => applyProperty(control.dataset.style, control.value.trim(), control)));
  function colorValue(control) {
    const currentAlpha = Number(control.dataset.alpha ?? 1);
    const alpha = control.dataset.color === "background-color" && currentAlpha === 0 ? 1 : currentAlpha;
    return alpha === 1 ? control.value : `rgb(${[1, 3, 5].map((i) => parseInt(control.value.slice(i, i + 2), 16)).join(" ")} / ${alpha})`;
  }
  colors.forEach((control) => control.addEventListener("change", () => applyProperty(control.dataset.color, colorValue(control), control)));
  [...controls, ...colors].forEach((control) => control.addEventListener("input", () => {
    propertyDraft = { control, property: control.dataset.style || control.dataset.color, value: control.dataset.color ? colorValue(control) : control.value.trim() };
    updateToolbar();
    scheduleDraft();
  }));
  $("advancedCss").addEventListener("input", () => { cssDraft = true; updateToolbar(); scheduleDraft(); });
  $("applyCssButton").addEventListener("click", applyAdvancedCss);
  $("deleteButton").addEventListener("click", removeSelected);
  $("editTextButton").addEventListener("click", () => beginText(selected));
  $("replaceImageButton").addEventListener("click", () => $("imageFile").click());
  $("imageFile").addEventListener("change", replaceImage);
  $("notesEditor").addEventListener("input", () => { notesDraft = true; updateToolbar(); scheduleDraft(); });
  $("notesEditor").addEventListener("change", finishNotes);
  $("pagesTab").addEventListener("click", () => setPanelView(true));
  $("modulesTab").addEventListener("click", () => setPanelView(false));
  $("undoButton").addEventListener("click", () => navigateHistory("undo"));
  $("redoButton").addEventListener("click", () => navigateHistory("redo"));
  $("saveButton").addEventListener("click", save);
  $("exportButton").addEventListener("click", exportCurrent);
  $("restoreDraftButton").addEventListener("click", restoreLocalDraft);
  $("exportDraftButton").addEventListener("click", () => { if (recovery) exportHtml(recovery.html, `${recovery.title}-草稿`); });
  $("discardDraftButton").addEventListener("click", discardLocalDraft);
  $("zoomLevel").addEventListener("change", () => setZoom($("zoomLevel").value));
  $("zoomLevel").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); setZoom($("zoomLevel").value); } });
  $("zoomInButton").addEventListener("click", () => setZoom(Math.min(200, Math.round(canvasScale * 100) + 10)));
  $("zoomOutButton").addEventListener("click", () => setZoom(Math.min(200, Math.max(10, Math.round(canvasScale * 100) - 10))));
  $("actualSizeButton").addEventListener("click", () => setZoom(100));
  $("fitCanvasButton").addEventListener("click", () => setZoom("fit"));
  $("panButton").addEventListener("click", () => setPan(!panMode));
  const viewport = $("canvasViewport");
  viewport.addEventListener("pointerdown", event => {
    if (!panMode || busy || event.button !== 0) return;
    event.preventDefault();
    panStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.dataset.dragging = "true";
  });
  viewport.addEventListener("pointermove", event => {
    if (!panStart) return;
    viewport.scrollLeft = panStart.left - (event.clientX - panStart.x);
    viewport.scrollTop = panStart.top - (event.clientY - panStart.y);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) viewport.addEventListener(type, () => { panStart = null; delete viewport.dataset.dragging; });
  $("retryButton").addEventListener("click", load);
  $("parentButton").addEventListener("click", () => select(selected?.parentElement, true));
  $("childButton").addEventListener("click", () => select(firstChild(selected), true));
  $("previewButton").addEventListener("click", () => {
    finishText();
    try { const url = new URL(previewUrl(record.url, location.href)); if (presentation) url.hash = `p=${presentation.index + 1}`; window.open(url.href, "_blank", "noopener,noreferrer"); }
    catch (error) { showMessage(error.message); }
  });
  $("treeToggle").addEventListener("click", () => setDrawer($("workbench").dataset.drawer === "tree" ? "" : "tree"));
  $("inspectorToggle").addEventListener("click", () => setDrawer($("workbench").dataset.drawer === "inspector" ? "" : "inspector"));
  $("drawerBackdrop").addEventListener("click", () => setDrawer(""));
  document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", () => setDrawer("")));
  document.addEventListener("keydown", keyboard);
  window.addEventListener("beforeunload", (event) => {
    if (hasChanges()) persistDraft();
    if (hasChanges() || busy && doc) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && hasChanges()) persistDraft(); });
  new ResizeObserver(fitCanvas).observe($("canvasViewport"));
  window.addEventListener("resize", () => { if (innerWidth >= 900) setDrawer(""); fitCanvas(); });
  load();
}

initializeEditor();
