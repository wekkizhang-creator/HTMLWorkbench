import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createInitialState, reducer } from "../public/pinshot/state.mjs";

test("capture variants retain distinct auto-copy and free-selection state", () => {
  let state = reducer(createInitialState(), { type: "CAPTURE_START", autoCopy: true, freeOnly: false });
  assert.equal(state.capture.autoCopy, true);
  assert.equal(state.capture.freeOnly, false);
  state = reducer(state, { type: "SELECTION_SET", rect: { x: 1, y: 2, width: 30, height: 20 } });
  assert.equal(state.capture.pendingAutoCopy, true);
  state = reducer(state, { type: "CAPTURE_AUTO_COPY_CONSUME" });
  assert.equal(state.capture.pendingAutoCopy, false);
  state = reducer(state, { type: "CAPTURE_CANCEL" });
  assert.equal(state.capture.autoCopy, false);
  state = reducer(state, { type: "CAPTURE_START", freeOnly: true });
  assert.equal(state.capture.freeOnly, true);
  state = reducer(state, { type: "CAPTURE_CANCEL" });
  assert.equal(state.capture.freeOnly, false);
  assert.equal(state.capture.autoCopy, false);
});

test("capture controller delegates visibility to the state renderer", async () => {
  const capture = await readFile("public/pinshot/capture.mjs", "utf8");
  assert.doesNotMatch(capture, /\.hidden\s*=/);
  assert.match(capture, /CAPTURE_PREVIEW_SET/);
  assert.match(capture, /CAPTURE_MAGNIFIER_SET/);
});

test("shortcut conflict message has status semantics before conflict early returns", async () => {
  const [html, view] = await Promise.all([
    readFile("public/pinshot.html", "utf8"),
    readFile("public/pinshot/settings-view.mjs", "utf8")
  ]);
  assert.match(view, /conflictMessages\.forEach/);
  assert.match(view, /const conflictMessages/);
});

test("complete delegates focus to successful close callback only", async () => {
  const app = await readFile("public/pinshot/app.mjs", "utf8");
  assert.doesNotMatch(app, /if \(command === "complete"\) captureLauncher\.focus\(\)/);
  assert.match(app, /closeCapture: \(\) => \{ capture\.cancel\(\); captureLauncher\.focus\(\); \}/);
});

test("renderer preserves the multiplication sign in the selection size label", async () => {
  const app = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(app, /sizeLabel\.textContent = `\$\{Math\.round\(displayRect\.width\)\} \u00d7 \$\{Math\.round\(displayRect\.height\)\}`/);
});
