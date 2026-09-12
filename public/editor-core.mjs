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
const EDITOR_STATE_ATTRIBUTE = "data-hwb-editor-state";
const EDITOR_NODE_KEY_ATTRIBUTE = "data-hwb-editor-node-key";
const TRANSIENT_ATTRIBUTES = [EDITOR_ID_ATTRIBUTE, "data-hwb-selected"];
const RESTORED_ATTRIBUTES = [
  "contenteditable",
  "spellcheck",
  ...TRANSIENT_ATTRIBUTES,
  EDITOR_UI_ATTRIBUTE,
  EDITOR_STATE_ATTRIBUTE,
  EDITOR_NODE_KEY_ATTRIBUTE
];
const editorDocumentState = new WeakMap();
const editorStatesByToken = new Map();
const MAX_HISTORY_COMMANDS = 100;
let nextEditorToken = 1;

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

function createEditorToken() {
  let token;
  do {
    token = `hwb-state-${nextEditorToken}`;
    nextEditorToken += 1;
  } while (editorStatesByToken.has(token));
  return token;
}

function isEditorUiNode(element, state) {
  return element?.getAttribute?.(EDITOR_UI_ATTRIBUTE) === state.token;
}

function captureElementState(element, state) {
  const key = `${state.token}-node-${state.nextNodeKey}`;
  state.nextNodeKey += 1;
  state.originalAttributes.set(
    key,
    Object.fromEntries(RESTORED_ATTRIBUTES.map((attribute) => [attribute, readAttribute(element, attribute)]))
  );
  state.elementKeys.set(element, key);
  element.setAttribute(EDITOR_NODE_KEY_ATTRIBUTE, key);
}

function captureNewElements(document, state, { initial = false } = {}) {
  for (const element of allDocumentElements(document)) {
    if (state.elementKeys.has(element)) continue;
    if (!initial && isEditorUiNode(element, state)) continue;
    captureElementState(element, state);
  }
}

function createDocumentState(document) {
  const token = createEditorToken();
  const state = {
    elementKeys: new WeakMap(),
    nextNodeKey: 1,
    originalAttributes: new Map(),
    sourceDocument: document,
    token
  };
  editorDocumentState.set(document, state);
  editorStatesByToken.set(token, state);

  // Token and node-key attributes survive cloning; their original values remain out of band.
  captureNewElements(document, state, { initial: true });
  document?.documentElement?.setAttribute?.(EDITOR_STATE_ATTRIBUTE, token);
  return state;
}

function stateForDocument(document) {
  const directState = editorDocumentState.get(document);
  if (directState) return directState;
  const token = document?.documentElement?.getAttribute?.(EDITOR_STATE_ATTRIBUTE);
  return token ? editorStatesByToken.get(token) : undefined;
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

  // Inline text belongs to its text block, but an image remains independently selectable.
  const textBlockOrImage = path.find((candidate) => {
    const tag = tagNameOf(candidate);
    return HEADING_TAGS.has(tag) || tag === "P" || tag === "IMG";
  });
  if (textBlockOrImage) return textBlockOrImage;

  const textLeaf = path.find((candidate) => isVisibleLeaf(candidate) && candidate.textContent?.trim());
  if (textLeaf) return textLeaf;

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
  const state = editorDocumentState.get(document) || createDocumentState(document);
  captureNewElements(document, state);
  const elements = bodyDescendants(document);

  let nextId = 1;
  for (const element of elements) {
    if (isEditorUiNode(element, state)) continue;
    element.setAttribute(EDITOR_ID_ATTRIBUTE, `hwb-${nextId}`);
    nextId += 1;
  }
  return state.token;
}

export function scrubEditorArtifacts(document) {
  const state = stateForDocument(document);
  if (!state) return;

  for (const element of allDocumentElements(document)) {
    const key = element.getAttribute?.(EDITOR_NODE_KEY_ATTRIBUTE);
    const original = key ? state.originalAttributes.get(key) : undefined;
    if (original) {
      for (const attribute of RESTORED_ATTRIBUTES) {
        restoreAttribute(element, attribute, original[attribute]);
      }
      continue;
    }

    if (tagNameOf(element) === "STYLE" && isEditorUiNode(element, state)) {
      element.remove?.();
    }
  }

  if (document === state.sourceDocument) {
    editorDocumentState.delete(document);
    editorStatesByToken.delete(state.token);
  }
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
    this.#emitChange(command, "execute");
  }

  undo() {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    this.#emitChange(command, "undo");
    return true;
  }

  redo() {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.redo();
    this.undoStack.push(command);
    this.#emitChange(command, "redo");
    return true;
  }

  #emitChange(command, action) {
    this.onChange?.(this.getState(), { command, action });
  }
}

function normalizeHistoryLimit(limit) {
  if (!Number.isFinite(limit)) return MAX_HISTORY_COMMANDS;
  return Math.min(MAX_HISTORY_COMMANDS, Math.max(1, Math.floor(limit)));
}
