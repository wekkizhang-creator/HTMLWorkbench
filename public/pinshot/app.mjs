import { createCaptureController } from "./capture.mjs";
import { createCanvasController } from "./canvas.mjs";
import { DEFAULT_SETTINGS } from "./settings.mjs";
import { createInitialState, createStore } from "./state.mjs";
import { createOutputRunner } from "./output.mjs";

const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");

const desktopScene = document.querySelector("#desktopScene");
const overlay = document.querySelector("#captureOverlay");
const canvas = document.querySelector("#annotationCanvas");
const toolbar = document.querySelector("#annotationToolbar");
const toast = document.querySelector("#toast");
const store = createStore(createInitialState());
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
  if (event.key !== "Enter" || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (!store.getState().selection) return;
  event.preventDefault();
  void runOutput("copy");
});
