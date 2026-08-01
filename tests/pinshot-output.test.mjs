import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadName, canvasToBlob, createOutputRunner } from "../public/pinshot/output.mjs";

test("download names are deterministic PNG names", () => {
  assert.equal(buildDownloadName(new Date("2026-08-01T08:09:07Z")), "PinShot-20260801-080907.png");
});

test("canvasToBlob rejects when the browser returns no blob", async () => {
  const canvas = { toBlob(callback) { callback(null); } };
  await assert.rejects(canvasToBlob(canvas), /无法生成 PNG/);
});

function selectedState() {
  return {
    mode: "annotating",
    selection: { x: 12, y: 24, width: 320, height: 180 },
    annotations: { past: [], present: [{ id: "a1", type: "rectangle" }], future: [] }
  };
}

test("copy output records history before closing a successful capture", async () => {
  const dispatched = [];
  const state = selectedState();
  const composite = { id: "composite" };
  const runOutput = createOutputRunner({
    store: { getState: () => state, dispatch: (action) => dispatched.push(action) },
    annotationCanvas: { id: "annotations" },
    getViewport: () => ({ width: 1440, height: 900 }),
    createComposite: () => composite,
    output: { copyCanvas: async (canvas) => { assert.equal(canvas, composite); return { type: "image/png" }; } },
    idFactory: () => "history-1",
    now: () => new Date("2026-08-01T08:09:07Z")
  });

  const result = await runOutput("copy");

  assert.equal(result.ok, true);
  assert.deepEqual(dispatched.map((action) => action.type), ["HISTORY_ADD", "CAPTURE_CANCEL", "TOAST_SHOW"]);
  assert.equal(dispatched[0].item.imageBlob.type, "image/png");
  assert.deepEqual(dispatched[0].item.selection, state.selection);
});

test("failed copy preserves the active capture session", async () => {
  const dispatched = [];
  const state = selectedState();
  const selection = state.selection;
  const annotations = state.annotations;
  const runOutput = createOutputRunner({
    store: { getState: () => state, dispatch: (action) => dispatched.push(action) },
    annotationCanvas: { id: "annotations" },
    getViewport: () => ({ width: 1440, height: 900 }),
    createComposite: () => ({ id: "composite" }),
    output: { copyCanvas: async () => { throw new Error("browser clipboard denied, use save"); } }
  });

  const result = await runOutput("copy");

  assert.equal(result.ok, false);
  assert.equal(state.mode, "annotating");
  assert.equal(state.selection, selection);
  assert.equal(state.annotations, annotations);
  assert.deepEqual(dispatched.map((action) => action.type), ["TOAST_SHOW"]);
  assert.match(dispatched[0].message, /save/);
});
