const modifierKeys = new Set(["Control", "Alt", "Shift", "Meta"]);
const editableSelector = "input,textarea,select,[contenteditable='true']";

export function normalizeShortcut(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  const key = event.key?.length === 1 ? event.key.toUpperCase() : event.key;
  if (key && !modifierKeys.has(key)) parts.push(key);
  return parts.join("+");
}

export function commandForShortcut(event, settings, mode) {
  if (event.target?.matches?.(editableSelector)) return null;
  const value = normalizeShortcut(event);
  const configured = Object.entries(settings.shortcuts || {}).find(([, shortcut]) => shortcut === value)?.[0];
  if (configured) return configured;
  if (value === "Enter" && ["selected", "annotating"].includes(mode)) return "copy";
  if (value === "Escape") return "escape";
  if (value === "Ctrl+Z" && mode === "annotating") return "undo";
  if (value === "Ctrl+Shift+Z" && mode === "annotating") return "redo";
  return null;
}

export function createKeyboardRouter({ settings, mode, execute }) {
  return {
    handle(event) {
      const command = commandForShortcut(event, settings(), mode());
      if (command && execute(command)) event.preventDefault();
      return command;
    }
  };
}

export function createEscapeHandler(layers) {
  return () => {
    const layer = layers.find((candidate) => candidate.active());
    if (!layer) return false;
    layer.close();
    return true;
  };
}
