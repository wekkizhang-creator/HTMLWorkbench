import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCaptureController } from "../public/pinshot/capture.mjs";
import { resizeRect } from "../public/pinshot/geometry.mjs";
import { createInitialState, createStore } from "../public/pinshot/state.mjs";

function fakeElement({ width = 0, height = 0, rect = { left: 0, top: 0, width, height } } = {}) {
  const listeners = new Map();
  return {
    hidden: false,
    style: {},
    clientWidth: width,
    clientHeight: height,
    get offsetWidth() { return this.hidden ? 0 : width; },
    getBoundingClientRect: () => ({ ...rect, width: rect.width || width, height: rect.height || height }),
    addEventListener(type, listener) { listeners.set(type, listener); },
    setPointerCapture() {},
    emit(type, event = {}) {
      listeners.get(type)?.({ button: 0, pointerId: 1, clientX: 0, clientY: 0, target: { closest: () => null }, ...event });
    }
  };
}

function createHarness() {
  const root = fakeElement({ width: 1000, height: 700 });
  const overlay = fakeElement();
  const elements = {
    root,
    overlay,
    selectionBox: fakeElement(),
    sizeLabel: fakeElement(),
    magnifier: fakeElement(),
    toolbar: fakeElement({ width: 200, height: 48 })
  };
  const store = createStore(createInitialState());
  const capture = createCaptureController(elements, store, () => ({ showMagnifierBorder: true }));
  capture.mount([{ id: "candidate", x: 80, y: 80, width: 160, height: 120 }]);
  return { capture, elements, store };
}

test("resizeRect keeps the opposite anchor fixed at minimum size and after crossing it", () => {
  const rect = { x: 100, y: 100, width: 300, height: 200 };
  const bounds = { width: 1440, height: 900 };
  assert.deepEqual(resizeRect(rect, "w", { x: 390, y: 120 }, bounds), { x: 376, y: 100, width: 24, height: 200 });
  assert.deepEqual(resizeRect(rect, "n", { x: 120, y: 290 }, bounds), { x: 100, y: 276, width: 300, height: 24 });
  assert.deepEqual(resizeRect(rect, "w", { x: 420, y: 120 }, bounds), { x: 376, y: 100, width: 24, height: 200 });
});

test("hovered candidate handles resize from preview geometry before selection is committed", () => {
  const { capture, elements, store } = createHarness();
  capture.start();
  elements.overlay.emit("pointermove", { clientX: 100, clientY: 100 });
  const handle = { dataset: { handle: "e" } };
  elements.overlay.emit("pointerdown", { clientX: 240, clientY: 140, target: { closest: () => handle } });
  assert.doesNotThrow(() => elements.overlay.emit("pointermove", { clientX: 280, clientY: 140, target: { closest: () => handle } }));
  elements.overlay.emit("pointerup", { clientX: 280, clientY: 140, target: { closest: () => handle } });
  assert.equal(store.getState().mode, "selected");
  assert.ok(store.getState().selection);
});

test("pointer cancellation clears an active drag before a later pointerup", () => {
  const { capture, elements, store } = createHarness();
  capture.start();
  elements.overlay.emit("pointerdown", { clientX: 500, clientY: 500 });
  elements.overlay.emit("pointermove", { clientX: 560, clientY: 560 });
  elements.overlay.emit("pointercancel");
  elements.overlay.emit("pointerup", { clientX: 600, clientY: 600 });
  assert.equal(store.getState().mode, "idle");
  assert.equal(store.getState().selection, null);
  assert.equal(elements.overlay.hidden, true);
});

test("toolbar placement measures its rendered width when initially hidden", () => {
  const { capture, elements } = createHarness();
  elements.toolbar.hidden = true;
  capture.start();
  elements.overlay.emit("pointerdown", { clientX: 850, clientY: 300 });
  elements.overlay.emit("pointerup", { clientX: 950, clientY: 400 });
  assert.equal(elements.toolbar.style.left, "800px");
});

test("resize handles keep a 10 pixel visual while exposing a 36 pixel hit target", async () => {
  const css = await readFile("public/pinshot/styles.css", "utf8");
  assert.match(css, /\.selection-box \[data-handle\] \{[^}]*width: 36px;[^}]*height: 36px;[^}]*background: transparent;/s);
  assert.match(css, /\.selection-box \[data-handle\]::after \{[^}]*width: 10px;[^}]*height: 10px;/s);
});
test("toolbar pointer lifecycle does not replace an active selection", () => {
  const { capture, elements, store } = createHarness();
  capture.start();
  elements.overlay.emit("pointerdown", { clientX: 500, clientY: 500 });
  elements.overlay.emit("pointerup", { clientX: 600, clientY: 580 });
  const selection = store.getState().selection;
  const toolbar = {};
  elements.overlay.emit("pointerdown", { clientX: 700, clientY: 600, target: { closest: (selector) => selector === "#annotationToolbar" ? toolbar : null } });
  elements.overlay.emit("pointerup", { clientX: 700, clientY: 600, target: { closest: (selector) => selector === "#annotationToolbar" ? toolbar : null } });
  assert.deepEqual(store.getState().selection, selection);
});
