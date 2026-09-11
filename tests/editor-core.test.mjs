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

function fakeElement(tagName, parentElement = null, attributes = {}) {
  const element = {
    tagName: tagName.toUpperCase(),
    parentElement,
    children: [],
    parentNode: parentElement,
    textContent: "",
    outerHTML: `<${tagName}></${tagName}>`,
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
  const temporaryEditable = fakeElement("span", originalEditable, { "data-hwb-selected": "true" });
  const editorStyle = fakeElement("style", body, { "data-hwb-editor-ui": "true" });
  const document = fakeDocument(body);

  assignEditorNodeIds(document);
  assert.equal(body.hasAttribute("data-hwb-editor-id"), false);
  assert.match(originalEditable.getAttribute("data-hwb-editor-id"), /^hwb-/);
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

test("serialization scrubs editor artifacts and retains the document doctype", () => {
  const body = fakeElement("body");
  const section = fakeElement("section", body);
  const document = fakeDocument(body);
  document.documentElement.outerHTML = '<html><head></head><body><section data-business="keep"></section></body></html>';

  assignEditorNodeIds(document);
  section.setAttribute("data-hwb-selected", "true");

  assert.equal(
    serializeDocument(document, "html"),
    '<!DOCTYPE html>\n<html><head></head><body><section data-business="keep"></section></body></html>'
  );
});

test("cleanup removes editor style nodes without deleting non-style content", () => {
  const body = fakeElement("body");
  const editorStyle = fakeElement("style", body, { "data-hwb-editor-ui": "true" });
  const userElement = fakeElement("div", body, { "data-hwb-editor-ui": "true" });
  const document = fakeDocument(body);

  scrubEditorArtifacts(document);

  assert.equal(editorStyle.removed, true);
  assert.equal(userElement.removed, undefined);
  assert.equal(userElement.hasAttribute("data-hwb-editor-ui"), false);
});

test("serialization retains public and system doctype identifiers", () => {
  const body = fakeElement("body");
  const document = fakeDocument(body);
  document.documentElement.outerHTML = "<html><head></head><body></body></html>";

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
