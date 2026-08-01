import assert from "node:assert/strict";
import test from "node:test";
import { annotationFromGesture, commitAnnotation, createAnnotationHistory, redoAnnotation, undoAnnotation } from "../public/pinshot/annotations.mjs";

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
