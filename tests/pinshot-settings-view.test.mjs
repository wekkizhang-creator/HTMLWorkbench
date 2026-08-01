import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../public/pinshot/settings.mjs";
import { normalizeShortcut, setNestedSetting } from "../public/pinshot/settings-view.mjs";

test("shortcut recording normalizes modifiers and rejects browser default shortcuts", () => {
  assert.equal(normalizeShortcut({ key: "p", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+P");
  assert.equal(normalizeShortcut({ key: "s", ctrlKey: true }), null);
  assert.equal(normalizeShortcut({ key: "Control", ctrlKey: true }), null);
});

test("nested setting updates preserve neighbouring values", () => {
  const next = setNestedSetting(DEFAULT_SETTINGS, "mouseActions.closePin", "RightClick");
  assert.equal(next.mouseActions.closePin, "RightClick");
  assert.equal(next.mouseActions.pinScale, DEFAULT_SETTINGS.mouseActions.pinScale);
  assert.notEqual(next.mouseActions, DEFAULT_SETTINGS.mouseActions);
});

test("settings wiring persists valid changes and exposes live capture and pin variables", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, css, pins] = await Promise.all([
    readFile("public/pinshot/app.mjs", "utf8"),
    readFile("public/pinshot/styles.css", "utf8"),
    readFile("public/pinshot/pins.mjs", "utf8")
  ]);
  assert.ok(app.indexOf("loadSettings(window.localStorage") < app.indexOf("createStore("));
  assert.match(app, /saveSettings\(window\.localStorage, next\)/);
  assert.match(app, /--capture-mask-opacity/);
  assert.match(app, /--pin-opacity/);
  assert.match(css, /--capture-border-width/);
  assert.match(css, /--pin-shadow/);
  assert.match(pins, /--card-opacity/);
});
