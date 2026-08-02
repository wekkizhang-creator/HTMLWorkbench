import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadName, canvasToBlob, copyCanvas, createCompositeCanvas, createOutputRunner } from "../public/pinshot/output.mjs";

test("download names use the selected deterministic output extension", () => {
  const date = new Date("2026-08-01T08:09:07Z");
  assert.equal(buildDownloadName(date), "PinShot-20260801-080907.png");
  assert.equal(buildDownloadName(date, "jpg"), "PinShot-20260801-080907.jpg");
});

test("canvas encoding honors the selected JPG output format", async () => {
  const calls = [];
  const canvas = { toBlob(callback, mimeType, quality) { calls.push({ mimeType, quality }); callback({ type: mimeType }); } };
  const blob = await canvasToBlob(canvas, "jpg");
  assert.equal(blob.type, "image/jpeg");
  assert.deepEqual(calls, [{ mimeType: "image/jpeg", quality: 0.92 }]);
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
  assert.match(dispatched[0].message, /\u590d\u5236\u5931\u8d25.*\u8bf7\u4f7f\u7528\u4fdd\u5b58/);
});

test("successful output announces copy and save in Chinese", async () => {
  const cases = [
    ["copy", "\u5df2\u590d\u5236\u5230\u526a\u8d34\u677f", { copyCanvas: async () => ({ type: "image/png" }) }],
    ["save", "\u622a\u56fe\u5df2\u4fdd\u5b58", { downloadCanvas: async () => ({ type: "image/png" }) }]
  ];

  for (const [command, message, output] of cases) {
    const dispatched = [];
    const runOutput = createOutputRunner({
      store: { getState: selectedState, dispatch: (action) => dispatched.push(action) },
      annotationCanvas: { id: "annotations" },
      getViewport: () => ({ width: 1440, height: 900 }),
      createComposite: () => ({ id: "composite" }),
      output
    });

    const result = await runOutput(command);

    assert.equal(result.ok, true);
    assert.equal(dispatched.at(-1).type, "TOAST_SHOW");
    assert.equal(dispatched.at(-1).message, message);
  }
});

test("save output forwards the current format setting", async () => {
  let receivedFormat = "";
  const runOutput = createOutputRunner({
    store: { getState: selectedState, dispatch: () => {} },
    annotationCanvas: { id: "annotations" },
    getViewport: () => ({ width: 1440, height: 900 }),
    getOutputFormat: () => "jpg",
    createComposite: () => ({ id: "composite" }),
    output: {
      downloadCanvas: async (_canvas, _documentRef, format) => {
        receivedFormat = format;
        return { type: "image/jpeg" };
      }
    }
  });

  const result = await runOutput("save");
  assert.equal(result.ok, true);
  assert.equal(receivedFormat, "jpg");
  assert.equal(result.blob.type, "image/jpeg");
});

test("composite uses the full DPR annotation backing store before scaling", () => {
  const drawImageCalls = [];
  const composite = {
    getContext: () => ({ drawImage: (...args) => drawImageCalls.push(args) })
  };
  const annotationCanvas = { width: 640, height: 360 };

  createCompositeCanvas(
    annotationCanvas,
    { x: 12, y: 24, width: 320, height: 180 },
    { width: 1440, height: 900 },
    { createElement: () => composite },
    () => {}
  );

  assert.deepEqual(drawImageCalls[0], [annotationCanvas, 0, 0, 640, 360, 0, 0, 320, 180]);
});

test("clipboard denials and unavailable APIs use the Chinese save fallback without ending capture", async () => {
  const blobCanvas = { toBlob(callback) { callback({ type: "image/png" }); } };
  await assert.rejects(copyCanvas(blobCanvas, {}), /\u590d\u5236\u5931\u8d25.*\u8bf7\u4f7f\u7528\u4fdd\u5b58/);

  const dispatched = [];
  const state = selectedState();
  const selection = state.selection;
  const annotations = state.annotations;
  const runOutput = createOutputRunner({
    store: { getState: () => state, dispatch: (action) => dispatched.push(action) },
    annotationCanvas: { id: "annotations" },
    getViewport: () => ({ width: 1440, height: 900 }),
    createComposite: () => ({ id: "composite" }),
    output: {
      copyCanvas: async () => {
        const error = new Error("clipboard access denied");
        error.name = "NotAllowedError";
        throw error;
      }
    }
  });

  const result = await runOutput("copy");

  assert.equal(result.ok, false);
  assert.equal(state.mode, "annotating");
  assert.equal(state.selection, selection);
  assert.equal(state.annotations, annotations);
  assert.deepEqual(dispatched.map((action) => action.type), ["TOAST_SHOW"]);
  assert.match(dispatched[0].message, /\u590d\u5236\u5931\u8d25.*\u8bf7\u4f7f\u7528\u4fdd\u5b58/);
});
