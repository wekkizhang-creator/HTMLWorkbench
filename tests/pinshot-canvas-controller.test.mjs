import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasController } from "../public/pinshot/canvas.mjs";

function createHarness({ tool = "rectangle", selection = { x: 100, y: 50, width: 40, height: 30 } } = {}) {
  const listeners = new Map();
  const calls = [];
  const parent = { children: [], append(element) { this.children.push(element); } };
  const context = {
    canvas: null,
    beginPath() { calls.push("beginPath"); }, moveTo() {}, lineTo() {}, stroke() {}, save() {}, restore() {},
    clearRect() { calls.push("clearRect"); }, strokeRect() { calls.push("strokeRect"); }, fillRect() {}, closePath() {}, fill() {}, arc() {}, fillText() {},
    setTransform(...args) { calls.push(["setTransform", ...args]); }
  };
  const canvas = {
    style: {}, width: 0, height: 0, parentElement: parent,
    getBoundingClientRect: () => ({ left: selection.x, top: selection.y }),
    getContext: () => context,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture() {},
    emit(type, event = {}) {
      const value = { pointerId: 1, clientX: 110, clientY: 60, currentTarget: canvas, stopPropagation() { value.stopped = true; }, ...event };
      listeners.get(type)?.(value);
      return value;
    }
  };
  context.canvas = canvas;
  const committed = [];
  const controller = createCanvasController({
    canvas,
    getSelection: () => selection,
    getTool: () => tool,
    getStyle: () => ({ color: "#4C8DFF", width: 3, fontSize: 42 }),
    onCommit(annotation) { committed.push(annotation); }
  });
  return { canvas, calls, committed, controller, parent, selection };
}

test("canvas previews an in-progress rectangle without committing it", () => {
  const { canvas, calls, committed, controller } = createHarness();
  controller.render([]);
  canvas.emit("pointerdown");
  calls.length = 0;
  canvas.emit("pointermove", { clientX: 130, clientY: 75 });
  assert.ok(calls.includes("strokeRect"));
  assert.equal(committed.length, 0);
});

test("inline text editor is positioned in overlay coordinates but commits local coordinates", () => {
  const originalDocument = globalThis.document;
  const inputListeners = new Map();
  globalThis.document = {
    createElement() {
      return {
        style: {}, value: "", remove() {}, focus() {}, setAttribute() {},
        addEventListener(type, listener) { inputListeners.set(type, listener); }
      };
    }
  };
  try {
    const { canvas, committed, parent } = createHarness({ tool: "text" });
    const event = canvas.emit("pointerdown", { clientX: 120, clientY: 70 });
    const input = parent.children[0];
    assert.equal(event.stopped, true);
    assert.equal(input.style.left, "120px");
    assert.equal(input.style.top, "70px");
    input.value = "备注";
    inputListeners.get("keydown")({ key: "Enter" });
    assert.deepEqual(committed.map((item) => ({ type: item.type, x: item.x, y: item.y, text: item.text })), [{ type: "text", x: 20, y: 20, text: "备注" }]);
    assert.equal(committed[0].fontSize, 42);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("canvas keeps CSS selection dimensions while using a device-pixel backing store", () => {
  const originalRatio = globalThis.devicePixelRatio;
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 2 });
  try {
    const { canvas, calls, controller } = createHarness();
    controller.render([]);
    assert.equal(canvas.width, 80);
    assert.equal(canvas.height, 60);
    assert.equal(canvas.style.width, "40px");
    assert.equal(canvas.style.height, "30px");
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "setTransform" && call[1] === 2));
  } finally {
    Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: originalRatio });
  }
});

test("opening a second text editor commits the first draft exactly once", () => {
  const originalDocument = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const listeners = new Map();
      const input = {
        style: {}, value: "", removed: false, remove() { this.removed = true; }, focus() {}, setAttribute() {},
        addEventListener(type, listener) { listeners.set(type, listener); },
        emit(type, event = {}) { listeners.get(type)?.(event); }
      };
      inputs.push(input);
      return input;
    }
  };
  try {
    const { canvas, committed } = createHarness({ tool: "text" });
    canvas.emit("pointerdown", { clientX: 120, clientY: 70 });
    inputs[0].value = "第一条";
    canvas.emit("pointerdown", { clientX: 130, clientY: 80 });
    assert.equal(inputs.length, 2);
    assert.deepEqual(committed.map((item) => item.text), ["第一条"]);
    inputs[0].emit("blur");
    assert.deepEqual(committed.map((item) => item.text), ["第一条"]);
    inputs[1].value = "第二条";
    inputs[1].emit("keydown", { key: "Enter" });
    assert.deepEqual(committed.map((item) => item.text), ["第一条", "第二条"]);
  } finally {
    globalThis.document = originalDocument;
  }
});
