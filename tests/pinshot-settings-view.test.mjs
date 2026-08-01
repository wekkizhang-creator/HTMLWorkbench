import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../public/pinshot/settings.mjs";
import { createSettingsView, normalizeShortcut, setNestedSetting } from "../public/pinshot/settings-view.mjs";

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
  assert.match(app, /settings\.showMask \? String\(settings\.maskOpacity \/ 100\) : "0"/);
  assert.match(app, /settings\.showBorder \? `\$\{settings\.borderWidth\}px` : "0px"/);
  assert.match(pins, /closePin"\) === "RightClick"/);
  assert.match(css, /--capture-handles-display/);
  assert.match(pins, /--card-opacity/);

});
class FakeElement {
  constructor({ dataset = {}, type = "", value = "", panel = null } = {}) {
    this.dataset = { ...dataset }; this.type = type; this.value = value; this.panel = panel;
    this.hidden = false; this.checked = false; this.textContent = ""; this.listeners = new Map(); this.attributes = new Map();
    this.style = { setProperty: () => {} }; this.classList = { toggle: () => {} }; this.focusCount = 0;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  fire(type, event = {}) { this.listeners.get(type)?.({ target: this, preventDefault: () => { this.prevented = true; }, ...event }); }
  closest(selector) { if (selector === "[data-setting]" && this.dataset.setting) return this; if (selector === "[data-settings-panel]") return this.panel; return null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focusCount += 1; }
}

function makeDialog() {
  const dialog = new FakeElement(); dialog.open = false; dialog.showModal = () => { dialog.open = true; }; dialog.close = () => { dialog.open = false; };
  const panels = ["general", "capture", "annotation", "pin", "shortcuts", "output"].map((name) => {
    const panel = new FakeElement({ dataset: { settingsPanel: name } }); panel.heading = new FakeElement(); panel.querySelector = (selector) => selector === "h2" ? panel.heading : null; panel.fields = []; panel.querySelectorAll = (selector) => selector === "[data-setting]" ? panel.fields : []; return panel;
  });
  const byPanel = Object.fromEntries(panels.map((panel) => [panel.dataset.settingsPanel, panel]));
  const fields = [
    new FakeElement({ dataset: { setting: "maskOpacity" }, type: "number", value: "55", panel: byPanel.capture }),
    new FakeElement({ dataset: { setting: "showMask" }, type: "checkbox", panel: byPanel.capture }),
    new FakeElement({ dataset: { setting: "shortcuts.paste", shortcutRecorder: "" }, panel: byPanel.shortcuts })
  ];
  fields.forEach((field) => field.panel.fields.push(field));
  const previews = panels.map(() => new FakeElement());
  const buttons = panels.map((panel) => new FakeElement({ dataset: { settingsSection: panel.dataset.settingsPanel } })); buttons[0].setAttribute("aria-current", "page");
  const groupReset = panels.map((panel) => new FakeElement({ panel }));
  const close = new FakeElement(); const resetAll = new FakeElement(); const conflict = new FakeElement();
  dialog.querySelectorAll = (selector) => ({ "[data-settings-section]": buttons, "[data-settings-panel]": panels, "[data-setting]": fields, ".settings-preview": previews, "[data-shortcut-recorder]": [fields[2]], "[data-reset-group]": groupReset }[selector] || []);
  dialog.querySelector = (selector) => {
    if (selector === "[data-settings-close]") return close; if (selector === "[data-reset-all]") return resetAll;
    if (selector === '[data-conflict-for="paste"]') return conflict; return null;
  };
  return { dialog, panels, fields, buttons, groupReset, close, resetAll, conflict };
}

test("settings controller synchronizes events, navigation, shortcuts, resets, and dialog state", () => {
  const fixture = makeDialog(); const changes = []; const resets = []; let closed = 0;
  const view = createSettingsView({ dialog: fixture.dialog, settings: { ...DEFAULT_SETTINGS, maskOpacity: 30, showMask: false }, onChange: (next) => changes.push(next), onReset: (next) => resets.push(next), onClose: () => { closed += 1; } });
  fixture.fields[0].value = "-1"; fixture.dialog.fire("change", { target: fixture.fields[0] });
  assert.equal(changes.at(-1).maskOpacity, 10);
  assert.equal(view.getSettings().maskOpacity, 10);
  assert.equal(fixture.fields[0].value, 10);
  fixture.buttons[2].fire("click"); assert.equal(fixture.panels[2].hidden, false); assert.equal(fixture.panels[2].heading.focusCount, 1); assert.equal(fixture.buttons[2].getAttribute("aria-current"), "page");
  fixture.fields[2].fire("click"); fixture.fields[2].fire("keydown", { key: "F1" }); assert.equal(view.getSettings().shortcuts.paste, "F3"); assert.match(fixture.conflict.textContent, /\u51b2\u7a81/);
  fixture.groupReset[1].fire("click"); assert.equal(view.getSettings().maskOpacity, DEFAULT_SETTINGS.maskOpacity); assert.equal(resets.length, 1);
  fixture.resetAll.fire("click"); assert.deepEqual(view.getSettings(), DEFAULT_SETTINGS); assert.equal(resets.length, 2);
  view.open(); assert.equal(fixture.dialog.open, true); fixture.close.fire("click"); assert.equal(fixture.dialog.open, false); assert.equal(closed, 1); assert.ok(changes.length >= 1);
});
