import { DEFAULT_SETTINGS, findShortcutConflict, sanitizeSettings } from "./settings.mjs";

const clone = (value) => structuredClone(value);
const blockedShortcuts = new Set(["Ctrl+S", "Ctrl+P", "Ctrl+W", "Ctrl+T", "Ctrl+L", "Alt+Left", "Alt+Right"]);

export function ensureIconButtonTitles(root) {
  for (const button of root.querySelectorAll("[data-icon-only]")) {
    if (!button.title) button.title = button.getAttribute("aria-label") || "";
  }
}


export function normalizeShortcut(event) {
  const key = event.key?.length === 1 ? event.key.toUpperCase() : event.key;
  if (!key || ["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  const value = [...parts, key].join("+");
  return blockedShortcuts.has(value) ? null : value;
}

export function setNestedSetting(settings, path, value) {
  const [group, key] = path.split(".");
  if (!key) return { ...settings, [group]: value };
  return { ...settings, [group]: { ...settings[group], [key]: value } };
}

function valueForField(field, settings) {
  return field.dataset.setting.split(".").reduce((value, key) => value?.[key], settings);
}

function writeFields(dialog, settings) {
  dialog.querySelectorAll("[data-setting]").forEach((field) => {
    const value = valueForField(field, settings);
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  });
}

function updatePreviews(dialog, settings) {
  dialog.querySelectorAll(".settings-preview").forEach((preview) => {
    preview.dataset.theme = settings.theme;
    preview.style.setProperty("--preview-accent", settings.annotationColor);
    preview.style.setProperty("--preview-mask", settings.showMask ? String(settings.maskOpacity / 100) : "0");
    preview.style.setProperty("--preview-border", settings.showBorder ? `${settings.borderWidth}px` : "0px");
    preview.style.setProperty("--preview-pin-opacity", String(settings.pinOpacity / 100));
    preview.dataset.captureFeedback = `${settings.showMask ? "遮罩 开" : "遮罩 关"} · ${settings.showBorder ? "边框 开" : "边框 关"} · ${settings.showHandles ? "控制点 开" : "控制点 关"}`;
    preview.classList.toggle("has-shadow", settings.pinShadow);
  });
}

function settingsForPanel(panel) {
  return [...panel.querySelectorAll("[data-setting]")].map((field) => field.dataset.setting);
}

export function createSettingsView({ dialog, settings, onChange = () => {}, onReset = onChange, onClose = () => {} }) {
  let current = clone(sanitizeSettings(settings));
  const sectionButtons = [...dialog.querySelectorAll("[data-settings-section]")];
  const panels = [...dialog.querySelectorAll("[data-settings-panel]")];
  const conflictMessages = [...dialog.querySelectorAll("[data-conflict-for]")];
  conflictMessages.forEach((element) => element.setAttribute("role", "status"));

  function commit(next, reset = false) {
    current = clone(sanitizeSettings(next));
    writeFields(dialog, current);
  const conflictMessages = [...dialog.querySelectorAll("[data-conflict-for]")];
  conflictMessages.forEach((element) => element.setAttribute("role", "status"));
    updatePreviews(dialog, current);
  dialog.querySelectorAll("[data-conflict-for]").forEach((element) => element.setAttribute("role", "status"));
    (reset ? onReset : onChange)(clone(current));
  }

  function setValue(path, value) {
    if (path.startsWith("shortcuts.")) {
      const action = path.split(".")[1];
      const conflict = findShortcutConflict(current.shortcuts, action, value);
      const message = dialog.querySelector(`[data-conflict-for="${action}"]`);
      if (message) message.textContent = conflict ? `与 ${conflict} 冲突，已保留原快捷键` : "";
      if (conflict) return false;
    }
    commit(setNestedSetting(current, path, value));
    return true;
  }

  function showSection(name) {
    sectionButtons.forEach((button) => button.setAttribute("aria-current", String(button.dataset.settingsSection === name ? "page" : "false")));
    panels.forEach((panel) => {
      const active = panel.dataset.settingsPanel === name;
      panel.hidden = !active;
      if (active) panel.querySelector("h2")?.focus();
    });
  }

  sectionButtons.forEach((button) => button.addEventListener("click", () => showSection(button.dataset.settingsSection)));
  dialog.addEventListener("change", (event) => {
    const field = event.target.closest("[data-setting]");
    if (!field || field.dataset.shortcutRecorder) return;
    const value = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
    setValue(field.dataset.setting, value);
  });
  dialog.querySelectorAll("[data-shortcut-recorder]").forEach((field) => {
    field.addEventListener("click", () => { field.dataset.recording = "true"; field.value = "请按组合键"; });
    field.addEventListener("keydown", (event) => {
      if (field.dataset.recording !== "true") return;
      event.preventDefault();
      const value = normalizeShortcut(event);
      if (!value) { field.value = valueForField(field, current); field.dataset.recording = "false"; return; }
      const accepted = setValue(field.dataset.setting, value);
      if (!accepted) field.value = valueForField(field, current);
      field.dataset.recording = "false";
    });
  });
  dialog.querySelector("[data-settings-close]")?.addEventListener("click", () => { dialog.close(); onClose(); });
  dialog.addEventListener("cancel", () => onClose());
  dialog.querySelector("[data-reset-all]")?.addEventListener("click", () => commit(clone(DEFAULT_SETTINGS), true));
  dialog.querySelectorAll("[data-reset-group]").forEach((button) => button.addEventListener("click", () => {
    const panel = button.closest("[data-settings-panel]");
    let next = clone(current);
    settingsForPanel(panel).forEach((path) => { next = setNestedSetting(next, path, valueForField({ dataset: { setting: path } }, DEFAULT_SETTINGS)); });
    commit(next, true);
  }));
  writeFields(dialog, current);
  updatePreviews(dialog, current);
  return {
    open() { if (!dialog.open) dialog.showModal(); showSection(sectionButtons.find((button) => button.getAttribute("aria-current") === "page")?.dataset.settingsSection || "general"); },
    close() { if (dialog.open) dialog.close(); },
    getSettings: () => clone(current),
    setValue,
    showSection
  };
}
