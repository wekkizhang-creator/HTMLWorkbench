import assert from "node:assert/strict";
import test from "node:test";
import { getMagnifierPosition, getSizeLabelPosition } from "../public/pinshot/capture.mjs";
import { clampRect, findCandidate, normalizeRect, placeToolbar, resizeRect } from "../public/pinshot/geometry.mjs";

test("magnifier flips and clamps inside every viewport edge", () => {
  const bounds = { width: 800, height: 600 };
  const size = { width: 132, height: 104 };
  assert.deepEqual(getMagnifierPosition({ x: 100, y: 80 }, bounds, size), { x: 120, y: 100 });
  assert.deepEqual(getMagnifierPosition({ x: 790, y: 590 }, bounds, size), { x: 638, y: 466 });
  assert.deepEqual(getMagnifierPosition({ x: 2, y: 2 }, { width: 100, height: 80 }, size), { x: 0, y: 0 });
});

test("selection size label stays inside viewport when the selection touches an edge", () => {
  const label = { getBoundingClientRect: () => ({ width: 82, height: 24 }) };
  assert.deepEqual(getSizeLabelPosition({ x: 780, y: 2, width: 20, height: 20 }, label, { width: 800, height: 600 }), { x: 718, y: 28 });
  assert.deepEqual(getSizeLabelPosition({ x: 40, y: 590, width: 80, height: 10 }, label, { width: 800, height: 600 }), { x: 40, y: 560 });
});

test("normalizeRect supports dragging in every direction", () => {
  assert.deepEqual(normalizeRect({ x: 300, y: 200 }, { x: 100, y: 80 }), { x: 100, y: 80, width: 200, height: 120 });
});

test("clampRect enforces a 24 pixel minimum inside the desktop", () => {
  assert.deepEqual(clampRect({ x: -10, y: 890, width: 8, height: 30 }, { width: 1440, height: 900 }, 24), { x: 0, y: 876, width: 24, height: 24 });
});

test("resizeRect moves the north-west handle and preserves bounds", () => {
  assert.deepEqual(resizeRect({ x: 100, y: 100, width: 300, height: 200 }, "nw", { x: 60, y: 80 }, { width: 1440, height: 900 }), { x: 60, y: 80, width: 340, height: 220 });
});

test("candidate hit testing chooses the smallest containing window", () => {
  const candidates = [
    { id: "large", x: 0, y: 0, width: 900, height: 700 },
    { id: "small", x: 100, y: 100, width: 400, height: 240 }
  ];
  assert.equal(findCandidate({ x: 180, y: 160 }, candidates).id, "small");
});

test("toolbar flips above when selection is near the bottom", () => {
  assert.deepEqual(placeToolbar({ x: 100, y: 820, width: 600, height: 70 }, { width: 720, height: 48 }, { width: 1440, height: 900 }), { x: 100, y: 760, placement: "above" });
});
