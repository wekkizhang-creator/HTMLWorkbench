import { createCaptureController, getToolbarPosition } from "./capture.mjs";
import { createCanvasController } from "./canvas.mjs";
import { DEFAULT_SETTINGS, loadSettings, resetSettings, saveSettings } from "./settings.mjs";
import { createSettingsView } from "./settings-view.mjs";
import { createEscapeHandler, createKeyboardRouter } from "./keyboard.mjs";
import { createInitialState, createStore } from "./state.mjs";
import { canvasToBlob, createCompositeCanvas, createOutputRunner } from "./output.mjs";
import { createPin, createPinActions, fitPinToViewport, renderPins, resolvePinSource } from "./pins.mjs";

const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");

const desktopScene = document.querySelector("#desktopScene");
const overlay = document.querySelector("#captureOverlay");
const canvas = document.querySelector("#annotationCanvas");
const selectionBox = document.querySelector("#selectionBox");
const sizeLabel = document.querySelector("#selectionSize");
const magnifier = document.querySelector("#magnifier");
const captureOverlay = document.querySelector("#captureOverlay");
const toolbar = document.querySelector("#annotationToolbar");
for (const button of toolbar.querySelectorAll("button")) {
  if (!button.hasAttribute("aria-pressed")) button.setAttribute("aria-pressed", "false");
  if (!button.dataset.tooltip) button.dataset.tooltip = button.getAttribute("aria-label") || "";
}
const toast = document.querySelector("#toast");
const pinLayer = document.querySelector("#pinLayer");
const historyStrip = document.querySelector("#historyStrip");
const trayMenu = document.querySelector("#trayMenu");
const captureLauncher = document.querySelector("#captureLauncher");
const trayLauncher = document.querySelector("#trayLauncher");
let recoveryNotice = "";
let activeSettings = loadSettings(window.localStorage, (message) => { recoveryNotice = message; });
const store = createStore(createInitialState());
const pinActions = createPinActions({
  clipboard: navigator.clipboard,
  ClipboardItemRef: globalThis.ClipboardItem,
  documentRef: document,
  URLRef: globalThis.URL
});

const capture = createCaptureController({
  root: desktopScene,
  overlay: captureOverlay,
  selectionBox,
  sizeLabel,
  magnifier,
  toolbar
}, store, () => activeSettings);
const annotationCanvas = createCanvasController({
  canvas,
  getSelection: () => store.getState().selection,
  getTool: () => store.getState().activeTool,
  getStyle: () => ({ color: activeSettings.annotationColor, width: activeSettings.annotationWidth }),
  onCommit: (annotation) => store.dispatch({ type: "ANNOTATION_COMMIT", annotation })
});

const runOutput = createOutputRunner({
  store,
  annotationCanvas: canvas,
  getViewport: () => ({ width: desktopScene.clientWidth, height: desktopScene.clientHeight }),
  documentRef: document,
  closeCapture: () => { capture.cancel(); captureLauncher.focus(); }
});

function nextId(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createPinFromSelection(source) {
  const state = store.getState();
  const { selection, imageBlob } = source;
  let blob = imageBlob;
  try {
    if (!blob) {
      const composite = createCompositeCanvas(canvas, selection, { width: desktopScene.clientWidth, height: desktopScene.clientHeight }, document);
      blob = await canvasToBlob(composite);
      store.dispatch({ type: "HISTORY_ADD", item: { id: nextId("history"), createdAt: new Date().toISOString(), width: composite.width, height: composite.height, selection: { ...selection }, imageBlob: blob } });
    }
    const initialPin = fitPinToViewport(
      createPin({ id: nextId("pin"), x: 80 + (state.pins.length % 4) * 24, y: 80 + (state.pins.length % 4) * 24, width: selection.width, height: selection.height, imageBlob: blob, group: state.activePinGroup }),
      { width: pinLayer.clientWidth, height: pinLayer.clientHeight },
      activeSettings.pinMaxSize
    );
    store.dispatch({ type: "PIN_CREATE", pin: initialPin });
    if (state.capture.active) {
      capture.cancel();
      captureLauncher.focus();
    }
    store.dispatch({ type: "TOAST_SHOW", message: "\u5df2\u6dfb\u52a0\u8d34\u56fe" });
  } catch (error) {
    store.dispatch({ type: "TOAST_SHOW", message: error instanceof Error ? error.message : "\u8d34\u56fe\u521b\u5efa\u5931\u8d25" });
  }
}

function render(state) {
  app.dataset.mode = state.mode;
  const selection = state.selection;
  toast.textContent = state.toast || "";
  toast.classList.toggle("is-visible", Boolean(state.toast));
  const captureView = state.capture;
  captureOverlay.hidden = !captureView.active;
  const displayRect = selection || captureView.preview;
  selectionBox.hidden = !displayRect;
  sizeLabel.hidden = !displayRect;
  magnifier.hidden = !captureView.magnifier;
  toolbar.hidden = !selection;
  if (displayRect) {
    Object.assign(selectionBox.style, { left: `${displayRect.x}px`, top: `${displayRect.y}px`, width: `${displayRect.width}px`, height: `${displayRect.height}px` });
    sizeLabel.textContent = `${Math.round(displayRect.width)} × ${Math.round(displayRect.height)}`;
    Object.assign(sizeLabel.style, { left: `${displayRect.x}px`, top: `${Math.max(0, displayRect.y - 30)}px` });
  }
  if (captureView.magnifier) Object.assign(magnifier.style, { left: `${captureView.magnifier.x}px`, top: `${captureView.magnifier.y}px` });
  Object.assign(toolbar.style, captureView.toolbarPosition ? { left: `${captureView.toolbarPosition.x}px`, top: `${captureView.toolbarPosition.y}px` } : { left: "", top: "" });
  historyStrip.hidden = state.history.length === 0;
  trayMenu.hidden = !state.trayOpen;
  trayLauncher.setAttribute("aria-expanded", String(state.trayOpen));
  if (state.settingsOpen && !settingsDialog.open) settingsView.open();
  if (!state.settingsOpen && settingsDialog.open) settingsView.close();
  canvas.hidden = !selection;
  if (selection) {
    Object.assign(canvas.style, {
      left: `${selection.x}px`, top: `${selection.y}px`,
      width: `${selection.width}px`, height: `${selection.height}px`,
      pointerEvents: state.activeTool === "select" ? "none" : "auto"
    });
    annotationCanvas.render(state.annotations.present);
  }
  renderPins(pinLayer, state.pins, (action) => store.dispatch(action), activeSettings, state.history, { actions: pinActions });
  for (const button of toolbar.querySelectorAll("[data-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === state.activeTool));
  }
}

store.subscribe((state, action) => {
  render(state);
  if (action.type === "SELECTION_SET" && state.capture.pendingAutoCopy) {
    store.dispatch({ type: "CAPTURE_AUTO_COPY_CONSUME" });
    void runOutput("copy");
  }
  if (action.type === "HISTORY_RESTORE" && state.selection) {
    store.dispatch({ type: "CAPTURE_TOOLBAR_SET", position: getToolbarPosition(state.selection, toolbar, { width: desktopScene.clientWidth, height: desktopScene.clientHeight }) });
  }
});

function applySettings(settings) {
  document.documentElement.dataset.theme = settings.theme;
  desktopScene.style.setProperty("--capture-mask-opacity", settings.showMask ? String(settings.maskOpacity / 100) : "0");
  desktopScene.style.setProperty("--capture-border-width", settings.showBorder ? `${settings.borderWidth}px` : "0px");
  desktopScene.style.setProperty("--capture-handles-display", settings.showHandles ? "block" : "none");
  desktopScene.style.setProperty("--magnifier-display", settings.showMagnifierBorder ? "block" : "none");
  pinLayer.style.setProperty("--pin-shadow", settings.pinShadow ? "0 16px 42px rgba(0,0,0,.34)" : "none");
  pinLayer.style.setProperty("--pin-opacity", String(settings.pinOpacity / 100));
}

const settingsDialog = document.querySelector("#settingsDialog");
const settingsView = createSettingsView({
  dialog: settingsDialog,
  settings: activeSettings,
  onChange(next) {
    activeSettings = saveSettings(window.localStorage, next);
    applySettings(activeSettings);
    render(store.getState());
  },
  onReset(next) {
    resetSettings(window.localStorage);
    activeSettings = saveSettings(window.localStorage, next);
    applySettings(activeSettings);
    render(store.getState());
  },
  onClose() { store.dispatch({ type: "SETTINGS_CLOSE" }); trayLauncher.focus(); }
});

document.querySelector("#trayLauncher").addEventListener("dblclick", () => {
  store.dispatch({ type: "SETTINGS_OPEN" });
  settingsView.open();
});
applySettings(activeSettings);
render(store.getState());
if (recoveryNotice) store.dispatch({ type: "TOAST_SHOW", message: recoveryNotice });
function closeCapture() {
  capture.cancel();
  captureLauncher.focus();
}

const escape = createEscapeHandler([
  { active: () => annotationCanvas.hasActiveTextInput(), close: () => annotationCanvas.cancelActiveTextInput() },
  { active: () => store.getState().trayOpen, close: () => store.dispatch({ type: "TRAY_TOGGLE" }) },
  { active: () => store.getState().settingsOpen, close: () => { settingsView.close(); store.dispatch({ type: "SETTINGS_CLOSE" }); trayLauncher.focus(); } },
  { active: () => store.getState().mode === "annotating" && store.getState().activeTool !== "select", close: () => store.dispatch({ type: "TOOL_CLEAR" }) },
  { active: () => store.getState().capture.active, close: closeCapture }
]);

function execute(command) {
  const state = store.getState();
  if (["select", "rectangle", "arrow", "pen", "highlight", "text", "number", "mosaic", "color"].includes(command)) {
    if (!state.selection) return false;
    store.dispatch({ type: "TOOL_SELECT", tool: command });
    return true;
  }
  if (command === "capture") { capture.start(); return true; }
  if (command === "captureAndCopy") { capture.start({ autoCopy: true }); return true; }
  if (command === "customCapture") { capture.start({ freeOnly: true }); return true; }
  if (command === "paste") {
    const pinSource = resolvePinSource(state);
    if (!pinSource) return false;
    void createPinFromSelection(pinSource);
    return true;
  }
  if (command === "togglePins") { store.dispatch({ type: "PIN_GROUP_TOGGLE", group: state.activePinGroup }); return true; }
  if (command === "cyclePinGroup") { store.dispatch({ type: "PIN_GROUP_CYCLE" }); return true; }
  if (command === "undo" && state.mode === "annotating") { store.dispatch({ type: "ANNOTATION_UNDO" }); return true; }
  if (command === "redo" && state.mode === "annotating") { store.dispatch({ type: "ANNOTATION_REDO" }); return true; }
  if (command === "escape") return escape();
  if (["copy", "save", "complete"].includes(command) && state.selection) {
    void runOutput(command);
    if (command === "complete") return true;
    return true;
  }
  return false;
}


toolbar.addEventListener("click", (event) => {
  const tool = event.target.closest("[data-tool]");
  if (tool) {
    execute(tool.dataset.tool);
    return;
  }
  const commandButton = event.target.closest("[data-command]");
  const command = commandButton?.dataset.command;
  if (command === "undo") execute("undo");
  if (command === "redo") execute("redo");
  if (command === "pin") {
    execute("paste");
    return;
  }
  if (["copy", "save", "complete"].includes(command)) {
    execute(command);
    return;
  }
  if (command && !["undo", "redo"].includes(command)) store.dispatch({ type: "TOAST_SHOW", message: `${commandButton.getAttribute("aria-label")}将在下一步实现` });
});

function candidateRects() {
  const rootRect = desktopScene.getBoundingClientRect();
  return [...desktopScene.querySelectorAll("[data-window-candidate]")].map((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return { id: candidate.dataset.windowCandidate, x: rect.left - rootRect.left, y: rect.top - rootRect.top, width: rect.width, height: rect.height };
  });
}

capture.mount(candidateRects());
captureLauncher.addEventListener("click", () => execute("capture"));

trayLauncher.addEventListener("click", () => store.dispatch({ type: "TRAY_TOGGLE" }));
trayMenu.addEventListener("click", (event) => {
  if (!event.target.closest("[data-open-settings]")) return;
  store.dispatch({ type: "SETTINGS_OPEN" });
});
const keyboard = createKeyboardRouter({ settings: () => activeSettings, mode: () => store.getState().mode, execute });
document.addEventListener("keydown", (event) => keyboard.handle(event));
