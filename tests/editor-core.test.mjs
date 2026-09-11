import assert from "node:assert/strict";
import test from "node:test";

import {
  EditorHistory,
  assignEditorNodeIds,
  chooseEditableElement,
  isProtectedElement,
  labelForElement,
  scrubEditorArtifacts,
  serializeDocument
} from "../public/editor-core.mjs";

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function fakeElement(tagName, parentElement = null, attributes = {}) {
  const element = {
    tagName: tagName.toUpperCase(),
    parentElement,
    children: [],
    parentNode: parentElement,
    textContent: "",
    _attributes: new Map(Object.entries(attributes)),
    appendChild(child) {
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    getAttribute(name) {
      return this._attributes.has(name) ? this._attributes.get(name) : null;
    },
    hasAttribute(name) {
      return this._attributes.has(name);
    },
    setAttribute(name, value) {
      this._attributes.set(name, String(value));
    },
    removeAttribute(name) {
      this._attributes.delete(name);
    },
    remove() {
      const siblings = this.parentNode?.children;
      const index = siblings?.indexOf(this) ?? -1;
      if (index >= 0) siblings.splice(index, 1);
      this.removed = true;
    }
  };
  Object.defineProperty(element, "outerHTML", {
    get() {
      const attributes = Array.from(this._attributes, ([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
      const content = this.children.length
        ? this.children.map((child) => child.outerHTML).join("")
        : this.textContent;
      return `<${tagName}${attributes}>${content}</${tagName}>`;
    }
  });
  if (parentElement) parentElement.appendChild(element);
  return element;
}

function fakeDocument(body) {
  const html = fakeElement("html");
  const head = fakeElement("head", html);
  body.parentElement = html;
  body.parentNode = html;
  html.children.push(body);
  return {
    body,
    head,
    documentElement: html,
    doctype: { name: "html" }
  };
}

function cloneFakeElement(element) {
  const clone = fakeElement(element.tagName.toLowerCase(), null, Object.fromEntries(element._attributes));
  clone.textContent = element.textContent;
  for (const child of element.children) {
    clone.appendChild(cloneFakeElement(child));
  }
  return clone;
}

function cloneFakeDocument(document) {
  const documentElement = cloneFakeElement(document.documentElement);
  return {
    body: documentElement.children.find((element) => element.tagName === "BODY"),
    head: documentElement.children.find((element) => element.tagName === "HEAD"),
    documentElement,
    doctype: { ...document.doctype }
  };
}

test("smart selection chooses a meaningful block and protects document roots", () => {
  const body = fakeElement("body");
  const section = fakeElement("section", body);
  const span = fakeElement("span", section);

  assert.equal(chooseEditableElement(span), section);
  assert.equal(isProtectedElement(fakeElement("body")), true);
  assert.equal(chooseEditableElement(fakeElement("script", body)), null);
});

test("selection keeps visible leaves when no semantic block exists", () => {
  const body = fakeElement("body");
  const wrapper = fakeElement("div", body);
  const image = fakeElement("img", wrapper);

  assert.equal(chooseEditableElement(image), image);
  assert.equal(chooseEditableElement(fakeElement("div")), null);
});

test("selection chooses the nearest list item or definition entry", () => {
  const body = fakeElement("body");
  const list = fakeElement("ul", body);
  const item = fakeElement("li", list);
  const nestedList = fakeElement("ol", item);
  const nestedItem = fakeElement("li", nestedList);
  const nestedText = fakeElement("span", nestedItem);
  const definitions = fakeElement("dl", body);
  const term = fakeElement("dt", definitions);
  const description = fakeElement("dd", definitions);

  assert.equal(chooseEditableElement(nestedText), nestedItem);
  assert.equal(chooseEditableElement(term), term);
  assert.equal(chooseEditableElement(description), description);
});

test("labels prefer accessible and element-specific context without long page text", () => {
  const heading = fakeElement("h2", null, { id: "results" });
  heading.textContent = "Quarterly revenue and conversion analysis for the international market";
  const image = fakeElement("img", null, { alt: "Spring collection cover" });
  const button = fakeElement("button", null, { "aria-label": "Open navigation", class: "menu compact" });

  assert.equal(labelForElement(heading), "h2#results: Quarterly revenue and conversion analysis for the international market");
  assert.equal(labelForElement(image), "img: Spring collection cover");
  assert.equal(labelForElement(button), "button: Open navigation");
});

test("transient IDs stay inside body and cleanup restores original edit attributes", () => {
  const body = fakeElement("body");
  const originalEditable = fakeElement("p", body, { contenteditable: "plaintext-only", spellcheck: "false", "data-business": "keep" });
  const temporaryEditable = fakeElement("span", originalEditable);
  const document = fakeDocument(body);

  const editorToken = assignEditorNodeIds(document);
  const editorStyle = fakeElement("style", body, { "data-hwb-editor-ui": editorToken });
  assert.equal(body.hasAttribute("data-hwb-editor-id"), false);
  assert.match(originalEditable.getAttribute("data-hwb-editor-id"), /^hwb-/);
  temporaryEditable.setAttribute("data-hwb-selected", "true");
  temporaryEditable.setAttribute("contenteditable", "true");
  temporaryEditable.setAttribute("spellcheck", "true");
  originalEditable.setAttribute("contenteditable", "true");
  originalEditable.setAttribute("spellcheck", "true");

  scrubEditorArtifacts(document);

  assert.equal(originalEditable.getAttribute("contenteditable"), "plaintext-only");
  assert.equal(originalEditable.getAttribute("spellcheck"), "false");
  assert.equal(temporaryEditable.hasAttribute("contenteditable"), false);
  assert.equal(temporaryEditable.hasAttribute("spellcheck"), false);
  assert.equal(originalEditable.getAttribute("data-business"), "keep");
  assert.equal(originalEditable.hasAttribute("data-hwb-editor-id"), false);
  assert.equal(temporaryEditable.hasAttribute("data-hwb-selected"), false);
  assert.equal(editorStyle.removed, true);
});

test("clone serialization removes editor state while preserving uploaded marker collisions", () => {
  const body = fakeElement("body");
  const section = fakeElement("section", body, {
    contenteditable: "plaintext-only",
    spellcheck: "false",
    "data-business": "keep",
    "data-hwb-editor-id": "uploaded-id",
    "data-hwb-selected": "uploaded-selection",
    "data-hwb-editor-ui": "uploaded-marker"
  });
  const temporaryEditable = fakeElement("span", section);
  const document = fakeDocument(body);
  const uploadedStyle = fakeElement("style", document.head, { "data-hwb-editor-ui": "uploaded-style" });
  uploadedStyle.textContent = ".uploaded { color: teal; }";
  const uploadedScript = fakeElement("script", document.head);
  uploadedScript.textContent = "window.keep = true;";

  const editorToken = assignEditorNodeIds(document);
  section.setAttribute("data-hwb-selected", "true");
  section.setAttribute("contenteditable", "true");
  section.setAttribute("spellcheck", "true");
  temporaryEditable.setAttribute("data-hwb-selected", "true");
  temporaryEditable.setAttribute("contenteditable", "true");
  temporaryEditable.setAttribute("spellcheck", "true");
  const editorStyle = fakeElement("style", body, { "data-hwb-editor-ui": editorToken });
  editorStyle.textContent = ".editor-outline { outline: 1px solid red; }";
  const clone = cloneFakeDocument(document);

  assert.equal(
    serializeDocument(clone, "html"),
    '<!DOCTYPE html>\n<html><head><style data-hwb-editor-ui="uploaded-style">.uploaded { color: teal; }</style><script>window.keep = true;</script></head><body><section contenteditable="plaintext-only" spellcheck="false" data-business="keep" data-hwb-editor-id="uploaded-id" data-hwb-selected="uploaded-selection" data-hwb-editor-ui="uploaded-marker"><span></span></section></body></html>'
  );
  assert.equal(section.getAttribute("contenteditable"), "true");
  assert.equal(editorStyle.removed, undefined);
});

test("post-setup nodes restore their original collisions during serialization", () => {
  const body = fakeElement("body");
  const document = fakeDocument(body);
  assignEditorNodeIds(document);

  const createdSection = fakeElement("section", body, {
    contenteditable: "plaintext-only",
    spellcheck: "false",
    "data-hwb-editor-id": "created-id",
    "data-hwb-selected": "created-selection",
    "data-hwb-editor-ui": "created-marker",
    "data-business": "keep"
  });
  const createdChild = fakeElement("span", createdSection);
  assignEditorNodeIds(document);
  createdSection.setAttribute("contenteditable", "true");
  createdSection.setAttribute("spellcheck", "true");
  createdSection.setAttribute("data-hwb-selected", "true");
  createdChild.setAttribute("contenteditable", "true");
  createdChild.setAttribute("spellcheck", "true");
  createdChild.setAttribute("data-hwb-selected", "true");

  assert.equal(
    serializeDocument(document, "html"),
    '<!DOCTYPE html>\n<html><head></head><body><section contenteditable="plaintext-only" spellcheck="false" data-hwb-editor-id="created-id" data-hwb-selected="created-selection" data-hwb-editor-ui="created-marker" data-business="keep"><span></span></section></body></html>'
  );
});

test("cleanup removes only style nodes injected after editor setup", () => {
  const body = fakeElement("body");
  const uploadedStyle = fakeElement("style", body, { "data-hwb-editor-ui": "uploaded-style" });
  const userElement = fakeElement("div", body, { "data-hwb-editor-ui": "uploaded-element" });
  const document = fakeDocument(body);

  const editorToken = assignEditorNodeIds(document);
  const editorStyle = fakeElement("style", body, { "data-hwb-editor-ui": editorToken });
  assignEditorNodeIds(document);
  scrubEditorArtifacts(document);

  assert.equal(editorStyle.removed, true);
  assert.equal(uploadedStyle.removed, undefined);
  assert.equal(uploadedStyle.getAttribute("data-hwb-editor-ui"), "uploaded-style");
  assert.equal(userElement.removed, undefined);
  assert.equal(userElement.getAttribute("data-hwb-editor-ui"), "uploaded-element");
});

test("serialization retains public and system doctype identifiers", () => {
  const body = fakeElement("body");
  const document = fakeDocument(body);

  assert.equal(
    serializeDocument(document, {
      name: "html",
      publicId: "-//W3C//DTD HTML 4.01//EN",
      systemId: "http://www.w3.org/TR/html4/strict.dtd"
    }),
    '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<html><head></head><body></body></html>'
  );
});

test("history executes, undoes and redoes commands", () => {
  const values = [];
  const history = new EditorHistory();
  history.execute({ redo: () => values.push("new"), undo: () => values.push("old") });
  history.undo();
  history.redo();
  assert.deepEqual(values, ["new", "old", "new"]);
});

test("history bounds undo commands, clears redo, and reports state changes", () => {
  const changes = [];
  const history = new EditorHistory({ limit: 2, onChange: (state) => changes.push(state) });
  const makeCommand = (value) => ({ redo() {}, undo() {}, value });

  history.execute(makeCommand("one"));
  history.execute(makeCommand("two"));
  history.execute(makeCommand("three"));
  assert.equal(history.undo(), true);
  history.execute(makeCommand("four"));

  assert.equal(history.undoStack.length, 2);
  assert.equal(history.redoStack.length, 0);
  assert.deepEqual(changes.at(-1), { canUndo: true, canRedo: false });
});

test("history clamps every configured limit to a finite one through one hundred", () => {
  const history = new EditorHistory({ limit: Infinity });
  const singleCommandHistory = new EditorHistory({ limit: 0 });

  for (let index = 0; index < 101; index += 1) {
    history.execute({ redo() {}, undo() {} });
  }

  assert.equal(history.limit, 100);
  assert.equal(history.undoStack.length, 100);
  assert.equal(singleCommandHistory.limit, 1);
  assert.equal(new EditorHistory({ limit: 101 }).limit, 100);
  assert.equal(new EditorHistory({ limit: Number.NaN }).limit, 100);
});
