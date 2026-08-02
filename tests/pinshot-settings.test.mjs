import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, findShortcutConflict, loadSettings, resetSettings, sanitizeSettings, saveSettings } from "../public/pinshot/settings.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test("invalid persisted settings fall back to defaults and report recovery", () => {
  const storage = memoryStorage({ "pinshot.settings.v1": "{broken" });
  let notice = "";
  assert.deepEqual(loadSettings(storage, (message) => { notice = message; }), DEFAULT_SETTINGS);
  assert.match(notice, /已恢复默认值/);
});

test("settings round trip retains valid values and clamps pin opacity", () => {
  const storage = memoryStorage();
  saveSettings(storage, { ...DEFAULT_SETTINGS, theme: "light", pinOpacity: 150 });
  const loaded = loadSettings(storage);
  assert.equal(loaded.theme, "light");
  assert.equal(loaded.pinOpacity, 100);
  assert.equal(loaded.mouseActions.closePin, "DoubleClick");
});

test("output format accepts JPG and recovers unsupported values to PNG", () => {
  assert.equal(sanitizeSettings({ outputFormat: "jpg" }).outputFormat, "jpg");
  assert.equal(sanitizeSettings({ outputFormat: "webp" }).outputFormat, "png");
});

test("pin maximum size is sanitized to the supported 320 through 12000 range", () => {
  assert.equal(sanitizeSettings({ pinMaxSize: 0 }).pinMaxSize, 320);
  assert.equal(sanitizeSettings({ pinMaxSize: 319 }).pinMaxSize, 320);
  assert.equal(sanitizeSettings({ pinMaxSize: 12001 }).pinMaxSize, 12000);
  assert.equal(sanitizeSettings({ pinMaxSize: Number.NaN }).pinMaxSize, DEFAULT_SETTINGS.pinMaxSize);

  const storage = memoryStorage({
    "pinshot.settings.v1": JSON.stringify({ pinMaxSize: -50 })
  });
  assert.equal(loadSettings(storage).pinMaxSize, 320);
});

test("pin maximum size field documents the supported browser range", async () => {
  const html = await import("node:fs/promises").then(({ readFile }) => readFile("public/pinshot.html", "utf8"));
  assert.match(html, /<input type="number" min="320" max="12000" data-setting="pinMaxSize">/);
});

test("shortcut conflicts name the existing action", () => {
  assert.equal(findShortcutConflict(DEFAULT_SETTINGS.shortcuts, "paste", "F1"), "capture");
  assert.equal(findShortcutConflict(DEFAULT_SETTINGS.shortcuts, "paste", "Alt+P"), null);
});

test("reset removes persisted overrides", () => {
  const storage = memoryStorage();
  saveSettings(storage, { ...DEFAULT_SETTINGS, theme: "light" });
  assert.deepEqual(resetSettings(storage), DEFAULT_SETTINGS);
});
