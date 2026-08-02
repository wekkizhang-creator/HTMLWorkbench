import assert from "node:assert/strict";
import test from "node:test";
import { annotationFromGesture, commitAnnotation, createAnnotationHistory, redoAnnotation, undoAnnotation } from "../public/pinshot/annotations.mjs";
import { annotationStyleFromSettings, createCanvasController } from "../public/pinshot/canvas.mjs";

test("annotation settings carry the configured text size into text creation", () => {
  const style = annotationStyleFromSettings({ annotationColor: "#F25F5C", annotationWidth: 5, annotationFontSize: 42 });
  assert.deepEqual(style, { color: "#F25F5C", width: 5, fontSize: 42 });
  assert.equal(annotationFromGesture("text", { x: 8, y: 9 }, { x: 8, y: 9 }, { ...style, text: "Hi" }).fontSize, 42);
});

test("color tool samples a scene pixel and commits the sampled value", () => {
  const listeners = new Map();
  const context = {
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {}
  };
  const canvas = {
    style: {},
    parentElement: { append() {} },
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    setPointerCapture() {},
    emit(type, values) {
      listeners.get(type)?.({ currentTarget: canvas, target: canvas, stopPropagation() {}, ...values });
    }
  };
  context.canvas = canvas;
  const commits = [];
  const samples = [];
  const controller = createCanvasController({
    canvas,
    getSelection: () => ({ x: 20, y: 30, width: 200, height: 120 }),
    getTool: () => "color",
    getStyle: () => ({ color: "#4C8DFF", width: 3, fontSize: 18 }),
    sampleColor: (point) => { assert.deepEqual(point, { x: 12, y: 16 }); return "#123456"; },
    onColorSample: (value) => samples.push(value),
    onCommit: (annotation) => commits.push(annotation)
  });
  canvas.emit("pointerdown", { pointerId: 4, clientX: 12, clientY: 16 });
  canvas.emit("pointerup", { pointerId: 4, clientX: 12, clientY: 16 });
  assert.equal(commits[0].value, "#123456");
  assert.equal(commits[0].color, "#123456");
  assert.deepEqual(samples, ["#123456"]);
  controller.destroy();
});

test("rectangle gesture creates a normalized annotation", () => {
  assert.deepEqual(annotationFromGesture("rectangle", { x: 80, y: 60 }, { x: 20, y: 10 }, { color: "#4C8DFF", width: 3 }), { type: "rectangle", x: 20, y: 10, width: 60, height: 50, color: "#4C8DFF", strokeWidth: 3 });
});

test("pen and highlighter gestures preserve point paths", () => {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  assert.equal(annotationFromGesture("pen", points[0], points[1], { points }).points.length, 2);
  assert.equal(annotationFromGesture("highlight", points[0], points[1], { points }).opacity, 0.35);
});

test("undo and redo move complete annotation snapshots", () => {
  let history = createAnnotationHistory();
  history = commitAnnotation(history, { id: "a", type: "rectangle" });
  history = commitAnnotation(history, { id: "b", type: "arrow" });
  history = undoAnnotation(history);
  assert.deepEqual(history.present.map((item) => item.id), ["a"]);
  history = redoAnnotation(history);
  assert.deepEqual(history.present.map((item) => item.id), ["a", "b"]);
});
