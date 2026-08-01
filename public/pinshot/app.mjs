import { createCaptureController } from "./capture.mjs";
import { createCanvasController } from "./canvas.mjs";
import { DEFAULT_SETTINGS } from "./settings.mjs";
import { createInitialState, createStore } from "./state.mjs";
import { canvasToBlob, createCompositeCanvas, createOutputRunner } from "./output.mjs";
import { renderPins } from "./pins.mjs";

const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");

const desktopScene = document.querySelector("#desktopScene");
const overlay = document.querySelector("#captureOverlay");
const canvas = document.querySelector("#annotationCanvas");
const toolbar = document.querySelector("#annotationToolbar");
const toast = document.querySelector("#toast");
const store = createStore(createInitialState());
const pinLayer = document.querySelector("#pinLayer");
const capture = createCaptureController({
  root: desktopScene,
  overlay,
  selectionBox: document.querySelector("#selectionBox"),
  sizeLabel: document.querySelector("#selectionSize"),
  magnifier: document.querySelector("#magnifier"),
  toolbar
}, store, () => DEFAULT_SETTINGS);
const annotationCanvas = createCanvasController({
  canvas,
  getSelection: () => store.getState().selection,
  getTool: () => store.getState().activeTool,
  getStyle: () => ({ color: "#4C8DFF", width: 3 }),
  onCommit: (annotation) => store.dispatch({ type: "ANNOTATION_COMMIT", annotation })
});

const runOutput = createOutputRunner({
  store,
  annotationCanvas: canvas,
  getViewport: () => ({ width: desktopScene.clientWidth, height: desktopScene.clientHeight }),
  documentRef: document,
  closeCapture: () => capture.cancel()
});

function nextId(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createPinFromSelection() {
  const state = store.getState();
  const restored = state.restoredHistory;
  const selection = restored?.selection || state.selection;
  if (!selection) return;
  let blob = restored?.imageBlob;
  try {
    if (!blob) {
      const composite = createCompositeCanvas(canvas, selection, { width: desktopScene.clientWidth, height: desktopScene.clientHeight }, document);
      blob = await canvasToBlob(composite);
      store.dispatch({ type: "HISTORY_ADD", item: { id: nextId("history"), createdAt: new Date().toISOString(), width: composite.width, height: composite.height, selection: { ...selection }, imageBlob: blob } });
    }
    store.dispatch({ type: "PIN_CREATE", pin: { id: nextId("pin"), x: 80 + (state.pins.length % 4) * 24, y: 80 + (state.pins.length % 4) * 24, width: selection.width, height: selection.height, imageBlob: blob, group: state.activePinGroup } });
    if (!overlay.hidden) capture.cancel();
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
  canvas.hidden = !selection;
  if (selection) {
    Object.assign(canvas.style, {
      left: `${selection.x}px`, top: `${selection.y}px`,
      width: `${selection.width}px`, height: `${selection.height}px`,
      pointerEvents: state.activeTool === "select" ? "none" : "auto"
    });
    annotationCanvas.render(state.annotations.present);
  }
  renderPins(pinLayer, state.pins, (action) => store.dispatch(action), DEFAULT_SETTINGS, state.history);
  for (const button of toolbar.querySelectorAll("[data-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === state.activeTool));
  }
}

store.subscribe(render);

toolbar.addEventListener("click", (event) => {
  const tool = event.target.closest("[data-tool]");
  if (tool) {
    store.dispatch({ type: "TOOL_SELECT", tool: tool.dataset.tool });
    return;
  }
  const commandButton = event.target.closest("[data-command]");
  const command = commandButton?.dataset.command;
  if (command === "undo") store.dispatch({ type: "ANNOTATION_UNDO" });
  if (command === "redo") store.dispatch({ type: "ANNOTATION_REDO" });
  if (command === "pin") {
    void createPinFromSelection();
    return;
  }
  if (["copy", "save", "complete"].includes(command)) {
    void runOutput(command);
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
document.querySelector("#captureLauncher").addEventListener("click", () => capture.start());

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (event.key === "F3") {
    event.preventDefault();
    if (event.ctrlKey) {
      store.dispatch({ type: "PIN_GROUP_CYCLE" });
    } else if (event.shiftKey) {
      store.dispatch({ type: "PIN_GROUP_TOGGLE", group: "default" });
    } else {
      void createPinFromSelection();
    }
    return;
  }
  if (event.key !== "Enter") return;
  if (!store.getState().selection) return;
  event.preventDefault();
  void runOutput("copy");
});
