import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { commandForShortcut, createEscapeHandler, createKeyboardRouter, normalizeShortcut } from "../public/pinshot/keyboard.mjs";
import { DEFAULT_SETTINGS } from "../public/pinshot/settings.mjs";

const key = (key, overrides = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides });

test("shortcut normalization uses stable modifier order", () => {
  assert.equal(normalizeShortcut(key("F1", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+F1");
});

test("default shortcuts map to approved commands", () => {
  assert.equal(commandForShortcut(key("F1"), DEFAULT_SETTINGS, "idle"), "capture");
  assert.equal(commandForShortcut(key("F3"), DEFAULT_SETTINGS, "selected"), "paste");
  assert.equal(commandForShortcut(key("Enter"), DEFAULT_SETTINGS, "selected"), "copy");
  assert.equal(commandForShortcut(key("Escape"), DEFAULT_SETTINGS, "annotating"), "escape");
  assert.equal(commandForShortcut(key("z", { ctrlKey: true }), DEFAULT_SETTINGS, "annotating"), "undo");
});

test("typing in a form field suppresses capture shortcuts", () => {
  assert.equal(commandForShortcut({ ...key("F1"), target: { matches: () => true } }, DEFAULT_SETTINGS, "idle"), null);
});

test("configured shortcuts and fallbacks share one handled execution path", () => {
  const handled = [];
  const router = createKeyboardRouter({ settings: () => DEFAULT_SETTINGS, mode: () => "annotating", execute: (command) => { handled.push(command); return true; } });
  const event = { ...key("z", { ctrlKey: true }), preventDefault: () => { event.prevented = true; } };
  router.handle(event);
  assert.deepEqual(handled, ["undo"]);
  assert.equal(event.prevented, true);
});

test("unhandled commands do not prevent default", () => {
  const router = createKeyboardRouter({ settings: () => DEFAULT_SETTINGS, mode: () => "idle", execute: () => false });
  const event = { ...key("F1"), preventDefault: () => { event.prevented = true; } };
  router.handle(event);
  assert.equal(event.prevented, undefined);
});


test("escape closes exactly one active layer in documented priority order", () => {
  const closed = [];
  const escape = createEscapeHandler([
    { active: () => true, close: () => closed.push("inline") },
    { active: () => true, close: () => closed.push("tray") },
    { active: () => true, close: () => closed.push("settings") },
    { active: () => true, close: () => closed.push("tool") },
    { active: () => true, close: () => closed.push("capture") }
  ]);
  assert.equal(escape(), true);
  assert.deepEqual(closed, ["inline"]);
});

test("escape is unhandled when every layer is inactive", () => {
  const escape = createEscapeHandler([{ active: () => false, close: () => assert.fail("should not close") }]);
  assert.equal(escape(), false);

test("app centralizes keyboard execution, escape layers and focus restoration", async () => {
  const app = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(app, /createKeyboardRouter/);
  assert.match(app, /function execute\(command\)/);
  assert.match(app, /hasActiveTextInput/);
  assert.match(app, /trayOpen/);
  assert.match(app, /settingsOpen/);
  assert.match(app, /capture\.cancel\(\)/);
  assert.match(app, /trayLauncher\.focus\(\)/);
  assert.match(app, /captureLauncher\.focus\(\)/);
});

test("shell exposes state-rendered accessibility affordances", async () => {
  const [html, css] = await Promise.all([readFile("public/pinshot.html", "utf8"), readFile("public/pinshot/styles.css", "utf8")]);
  assert.match(html, /id="trayMenu"[^>]*hidden/);
  assert.match(html, /role="status"/);
  assert.match(html, /data-tooltip/);
  assert.match(css, /\.sr-only/);
  assert.match(css, /\[data-tooltip\]::after/);
  assert.match(css, /prefers-contrast/);
});
});
test("router ignores editable targets before dispatching", () => {
  let called = false;

test("pin completion restores focus after cancelling an active capture", async () => {
  const app = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(app, /if \(!overlay\.hidden\) \{\s*capture\.cancel\(\);\s*captureLauncher\.focus\(\);\s*\}/s);
});
  const router = createKeyboardRouter({ settings: () => DEFAULT_SETTINGS, mode: () => "idle", execute: () => { called = true; return true; } });
  router.handle({ ...key("F1"), target: { matches: () => true }, preventDefault() {} });
  assert.equal(called, false);
});
