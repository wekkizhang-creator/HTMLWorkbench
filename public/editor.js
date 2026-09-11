import {
  assignEditorNodeIds, chooseEditableElement, EditorHistory, isProtectedElement,
  labelForElement, scrubEditorArtifacts, serializeDocument
} from "./editor-core.mjs";

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
  let rows = new Map();
  let history = newHistory();

  function newHistory() {
    return new EditorHistory({ onChange() { dirty = true; refresh(); } });
  }

  function hasChanges() {
    return dirty || hasPendingChanges();
  }

  function hasPendingChanges() {
    return cssDraft || Boolean(propertyDraft) || Boolean(textSession && textSession.element.innerHTML !== textSession.before);
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
    $("saveState").dataset.dirty = String(hasChanges());
    $("saveState").textContent = busy ? "正在处理…" : !doc ? "尚未载入" : hasChanges() ? "有未保存更改" : "已同步";
    $("workbench").dataset.busy = String(busy);
    canvas.inert = busy;
    $("styleInspector").disabled = busy || !selected;
    $("styleInspector").hidden = !selected;
    $("parentButton").disabled = busy || !editable(selected?.parentElement);
    $("childButton").disabled = busy || !firstChild(selected);
  }

  function editable(element) {
    return Boolean(element && doc?.body?.contains(element) && !isProtectedElement(element));
  }

  function firstChild(element) {
    return [...(element?.children || [])].find(editable);
  }

  function outline(element, target) {
    if (!editable(element) || busy || textSession) { target.hidden = true; return; }
    const rect = element.getBoundingClientRect();
    target.hidden = !rect.width || !rect.height;
    Object.assign(target.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
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
        row.addEventListener("click", () => { if (select(element, true)) setDrawer(""); });
        rows.set(element, row);
        fragment.append(row);
        visit(element, depth + 1);
      }
    }
    if (doc?.body) visit(doc.body, 0);
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
      const components = computed.getPropertyValue(control.dataset.color).match(/[\d.]+/g);
      control.value = components?.length >= 3 ? `#${components.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, "0")).join("")}` : "#000000";
    }
    $("advancedCss").value = selected.style.cssText;
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
  }

  function select(element, scroll = false) {
    if (busy) return false;
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
      if (element.querySelector("script,style,link,meta,iframe,object,input,textarea,select,button,img,video,audio,svg,canvas")) return null;
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
      history.execute({ undo() { restoreChildren(element, nodes); }, redo() { restoreChildren(element, afterNodes); } });
    } else updateToolbar();
  }

  function applyStyle(cssText) {
    if (!editable(selected) || busy) return;
    finishText();
    const element = selected;
    const before = element.getAttribute("style");
    if ((before || "") === cssText) { cssDraft = false; updateToolbar(); return; }
    history.execute({
      undo() { if (before === null) element.removeAttribute("style"); else element.setAttribute("style", before); },
      redo() { element.style.cssText = cssText; }
    });
  }

  function applyProperty(property, value, control) {
    if (!selected || busy) return false;
    if (cssDraft && !applyAdvancedCss()) return false;
    const style = document.createElement("div").style;
    style.cssText = selected.style.cssText;
    if (value && !CSS.supports(property, value)) {
      control?.setAttribute("aria-invalid", "true");
      showMessage(`无效的 ${property} 值：${value}`);
      return false;
    }
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
    propertyDraft = null;
    showMessage();
    applyStyle(style.cssText);
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
    if (!editable(selected) || busy) return;
    const element = selected;
    const parent = element.parentNode;
    const next = element.nextSibling;
    history.execute({
      undo() { parent.insertBefore(element, next?.parentNode === parent ? next : null); selected = element; },
      redo() { element.remove(); selected = editable(parent) ? parent : null; }
    });
  }

  function navigateHistory(direction) {
    if (busy) return;
    finishText();
    if (!commitPropertyDraft()) return;
    if (cssDraft && !applyAdvancedCss()) return;
    history[direction]();
  }

  function keyboard(event) {
    if (event.key === "Escape") { finishText(); setDrawer(""); return; }
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
    if (name) $(name === "tree" ? "treePanel" : "inspectorPanel").querySelector("button")?.focus();
    else if (previous) $(previous === "tree" ? "treeToggle" : "inspectorToggle").focus();
  }

  function attachDocument() {
    frameCleanup();
    const removers = [];
    const on = (target, type, listener, options) => {
      target.addEventListener(type, listener, options);
      removers.push(() => target.removeEventListener(type, listener, options));
    };
    on(doc, "pointermove", (event) => { hovered = chooseEditableElement(event.target); drawOutlines(); });
    on(doc, "pointerleave", () => { hovered = null; drawOutlines(); });
    on(doc, "pointerdown", (event) => {
      if (!textSession && event.target.closest?.("input,textarea,select,button")) event.preventDefault();
    }, true);
    on(doc, "click", (event) => {
      if (textSession?.element.contains(event.target)) return;
      event.preventDefault();
      select(chooseEditableElement(event.target));
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
    on(doc, "input", updateToolbar, true);
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
    frameCleanup();
    frameCleanup = () => {};
    if (doc) scrubEditorArtifacts(doc);
    if (sourceDoc) scrubEditorArtifacts(sourceDoc);
    doc = null;
    sourceDoc = null;
  }

  function mount(html) {
    releaseDocument();
    sourceDoc = new DOMParser().parseFromString(html, "text/html");
    doctype = sourceDoc.doctype?.cloneNode() || null;
    assignEditorNodeIds(sourceDoc);
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
    if (!sourceDoc.querySelector("base[href]")) {
      const base = sourceDoc.createElement("base");
      base.href = previewUrl(record.url, location.href);
      base.dataset.editorHelper = helperToken;
      sourceDoc.head.append(base);
    }
    canvas.onload = () => {
      clearTimeout(mountTimer);
      try {
        const mounted = canvas.contentDocument;
        if (!mounted?.body || !mounted.documentElement.hasAttribute("data-hwb-editor-state")) throw new Error("画布导航已停止，请重新载入。");
        doc = mounted;
        helperNodes = new Set(doc.querySelectorAll(`[data-editor-helper="${helperToken}"]`));
        // Keep the source state alive: its keys also identify nodes in srcdoc and history snapshots.
        attachDocument();
        busy = false;
        $("loadState").hidden = true;
        refresh();
      } catch (error) { loadFailure(error); }
    };
    canvas.srcdoc = `${doctype ? new XMLSerializer().serializeToString(doctype) : ""}\n${sourceDoc.documentElement.outerHTML}`;
    mountTimer = setTimeout(() => loadFailure(new Error("画布载入超时，请重试。")), 20000);
  }

  function serializedHtml() {
    const clone = doc.cloneNode(true);
    const originals = [doc.documentElement, ...doc.documentElement.querySelectorAll("*")];
    const copies = [clone.documentElement, ...clone.documentElement.querySelectorAll("*")];
    originals.forEach((element, index) => {
      if (helperNodes.has(element)) copies[index].remove();
      const refresh = refreshAttributes.get(element.getAttribute("data-hwb-editor-node-key"));
      if (refresh) copies[index].setAttribute("http-equiv", refresh);
    });
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
    const current = ++generation;
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
      version = response.headers.get("ETag") || payload.version;
      $("documentTitle").textContent = record.title || record.originalName || "未命名 HTML";
      document.title = `${$("documentTitle").textContent} · HTML 编辑器`;
      $("documentSize").textContent = `${(new TextEncoder().encode(payload.html).byteLength / 1024).toFixed(1)} KB`;
      mount(payload.html);
    } catch (error) { if (current === generation) loadFailure(error); }
  }

  async function save() {
    if (busy || !doc) return;
    finishText();
    if (!commitPropertyDraft()) return;
    if (cssDraft && !applyAdvancedCss()) return;
    if (!hasChanges()) return;
    showMessage();
    try {
      const html = serializedHtml();
      const options = createSaveRequest(html, version);
      busy = true;
      updateToolbar();
      options.headers["X-CSRF-Token"] = await fetchSession();
      const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(60000) });
      const payload = await responsePayload(response);
      if (!payload.version || !payload.record) throw new Error("保存响应不完整，请确认服务器状态后重试。");
      record = payload.record;
      version = response.headers.get("ETag") || payload.version;
      dirty = false;
      history = newHistory();
      $("documentSize").textContent = `${(new TextEncoder().encode(html).byteLength / 1024).toFixed(1)} KB`;
      showMessage("已保存并发布。");
    } catch (error) { showMessage(error.message || "保存失败，当前更改仍保留。"); }
    finally { busy = false; updateToolbar(); drawOutlines(); }
  }

  controls.forEach((control) => control.addEventListener("change", () => applyProperty(control.dataset.style, control.value.trim(), control)));
  colors.forEach((control) => control.addEventListener("change", () => applyProperty(control.dataset.color, control.value, control)));
  [...controls, ...colors].forEach((control) => control.addEventListener("input", () => {
    propertyDraft = { control, property: control.dataset.style || control.dataset.color, value: control.value.trim() };
    updateToolbar();
  }));
  $("advancedCss").addEventListener("input", () => { cssDraft = true; updateToolbar(); });
  $("applyCssButton").addEventListener("click", applyAdvancedCss);
  $("deleteButton").addEventListener("click", removeSelected);
  $("undoButton").addEventListener("click", () => navigateHistory("undo"));
  $("redoButton").addEventListener("click", () => navigateHistory("redo"));
  $("saveButton").addEventListener("click", save);
  $("retryButton").addEventListener("click", load);
  $("parentButton").addEventListener("click", () => select(selected?.parentElement, true));
  $("childButton").addEventListener("click", () => select(firstChild(selected), true));
  $("previewButton").addEventListener("click", () => {
    finishText();
    try { window.open(previewUrl(record.url, location.href), "_blank", "noopener,noreferrer"); }
    catch (error) { showMessage(error.message); }
  });
  $("treeToggle").addEventListener("click", () => setDrawer($("workbench").dataset.drawer === "tree" ? "" : "tree"));
  $("inspectorToggle").addEventListener("click", () => setDrawer($("workbench").dataset.drawer === "inspector" ? "" : "inspector"));
  $("drawerBackdrop").addEventListener("click", () => setDrawer(""));
  document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", () => setDrawer("")));
  document.addEventListener("keydown", keyboard);
  window.addEventListener("beforeunload", (event) => {
    if (hasChanges() || busy && doc) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("resize", drawOutlines);
  load();
}

initializeEditor();
