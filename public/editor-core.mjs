export const PROTECTED_TAGS = new Set([
  "HTML",
  "HEAD",
  "BODY",
  "SCRIPT",
  "STYLE",
  "LINK",
  "META"
]);

const SEMANTIC_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIALOG", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "HEADER", "MAIN",
  "LI", "MENU", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL"
]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const EDITOR_ID_ATTRIBUTE = "data-hwb-editor-id";
const EDITOR_UI_ATTRIBUTE = "data-hwb-editor-ui";
const TRANSIENT_ATTRIBUTES = [EDITOR_ID_ATTRIBUTE, "data-hwb-selected"];
const RESTORED_ATTRIBUTES = ["contenteditable", "spellcheck", ...TRANSIENT_ATTRIBUTES, EDITOR_UI_ATTRIBUTE];
const editorDocumentState = new WeakMap();
const MAX_HISTORY_COMMANDS = 100;

function tagNameOf(element) {
  return typeof element?.tagName === "string" ? element.tagName.toUpperCase() : "";
}

function childElements(element) {
  return Array.from(element?.children || []);
}

function bodyDescendants(document) {
  const elements = [];
  const visit = (element) => {
    for (const child of childElements(element)) {
      elements.push(child);
      visit(child);
    }
  };
  visit(document?.body);
  return elements;
}

function allDocumentElements(document) {
  const root = document?.documentElement;
  if (!root) return [];

  const elements = [root];
  const visit = (element) => {
    for (const child of childElements(element)) {
      elements.push(child);
      visit(child);
    }
  };
  visit(root);
  return elements;
}

function captureDocumentState(document) {
  if (editorDocumentState.has(document)) return;

  const elements = allDocumentElements(document);
  const originalAttributes = new Map();
  for (const element of elements) {
    originalAttributes.set(
      element,
      Object.fromEntries(RESTORED_ATTRIBUTES.map((attribute) => [attribute, readAttribute(element, attribute)]))
    );
  }
  editorDocumentState.set(document, { originalAttributes, originalElements: new Set(elements) });
}

function readAttribute(element, name) {
  return {
    present: Boolean(element?.hasAttribute?.(name)),
    value: element?.getAttribute?.(name)
  };
}

function restoreAttribute(element, name, original) {
  if (original.present) {
    element.setAttribute(name, original.value);
  } else {
    element.removeAttribute(name);
  }
}

function isHidden(element) {
  return element?.hasAttribute?.("hidden") || element?.getAttribute?.("aria-hidden") === "true";
}

function isVisibleLeaf(element) {
  return childElements(element).length === 0 && !isHidden(element);
}

function textPreview(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) return normalized;
  return `${normalized.slice(0, 77).trimEnd()}...`;
}

function selectorLabel(element, { includeClass = true } = {}) {
  const tag = tagNameOf(element).toLowerCase();
  const id = element?.getAttribute?.("id");
  if (id) return `${tag}#${id}`;

  const className = includeClass ? element?.getAttribute?.("class") : null;
  const firstClass = className?.trim().split(/\s+/)[0];
  return firstClass ? `${tag}.${firstClass}` : tag;
}

export function isProtectedElement(element) {
  return PROTECTED_TAGS.has(tagNameOf(element));
}

export function chooseEditableElement(element) {
  if (!element || isProtectedElement(element)) return null;

  const path = [];
  let current = element;
  while (current && tagNameOf(current) !== "BODY") {
    if (isProtectedElement(current)) return null;
    path.push(current);
    current = current.parentElement;
  }
  if (tagNameOf(current) !== "BODY") return null;

  const semanticBlock = path.find((candidate) => SEMANTIC_BLOCK_TAGS.has(tagNameOf(candidate)));
  return semanticBlock || path.find(isVisibleLeaf) || null;
}

export function labelForElement(element) {
  const tag = tagNameOf(element);
  if (!tag) return "element";

  const accessibleName = element.getAttribute?.("aria-label");
  const imageAlt = tag === "IMG" ? element.getAttribute?.("alt") : null;
  const headingText = HEADING_TAGS.has(tag) ? element.textContent : null;
  const context = textPreview(accessibleName || imageAlt || headingText);
  return context
    ? `${selectorLabel(element, { includeClass: false })}: ${context}`
    : selectorLabel(element);
}

export function assignEditorNodeIds(document) {
  captureDocumentState(document);
  const elements = bodyDescendants(document);

  let nextId = 1;
  for (const element of elements) {
    element.setAttribute(EDITOR_ID_ATTRIBUTE, `hwb-${nextId}`);
    nextId += 1;
  }
}

export function scrubEditorArtifacts(document) {
  const state = editorDocumentState.get(document);
  for (const element of allDocumentElements(document)) {
    if (
      state
      && tagNameOf(element) === "STYLE"
      && !state.originalElements.has(element)
      && element.hasAttribute?.(EDITOR_UI_ATTRIBUTE)
    ) {
      element.remove?.();
      continue;
    }

    const original = state?.originalAttributes.get(element);
    if (original) {
      for (const attribute of RESTORED_ATTRIBUTES) {
        restoreAttribute(element, attribute, original[attribute]);
      }
    }
  }
  editorDocumentState.delete(document);
}

export function serializeDocument(document, doctype = document?.doctype) {
  scrubEditorArtifacts(document);
  const serialized = document?.documentElement?.outerHTML || "";
  if (!doctype) return serialized;

  const declaration = doctypeDeclaration(doctype);
  return declaration ? `${declaration}\n${serialized}` : serialized;
}

function doctypeDeclaration(doctype) {
  if (typeof doctype === "string") return `<!DOCTYPE ${doctype}>`;
  if (!doctype?.name) return "";
  if (doctype.publicId) {
    const systemId = doctype.systemId ? ` "${doctype.systemId}"` : "";
    return `<!DOCTYPE ${doctype.name} PUBLIC "${doctype.publicId}"${systemId}>`;
  }
  if (doctype.systemId) return `<!DOCTYPE ${doctype.name} SYSTEM "${doctype.systemId}">`;
  return `<!DOCTYPE ${doctype.name}>`;
}

export class EditorHistory {
  constructor({ limit = 100, onChange } = {}) {
    this.limit = normalizeHistoryLimit(limit);
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
  }

  getState() {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  execute(command) {
    if (typeof command?.redo !== "function" || typeof command.undo !== "function") {
      throw new TypeError("Editor history commands need redo and undo functions");
    }
    command.redo();
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.#emitChange();
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    this.#emitChange();
    return true;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo();
    this.undoStack.push(command);
    this.#emitChange();
    return true;
  }

  #emitChange() {
    this.onChange?.(this.getState());
  }
}

function normalizeHistoryLimit(limit) {
  if (!Number.isFinite(limit)) return MAX_HISTORY_COMMANDS;
  return Math.min(MAX_HISTORY_COMMANDS, Math.max(1, Math.floor(limit)));
}
