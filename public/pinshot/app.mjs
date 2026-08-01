import { createCaptureController } from "./capture.mjs";
import { DEFAULT_SETTINGS } from "./settings.mjs";
import { createInitialState, createStore } from "./state.mjs";

const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");

const desktopScene = document.querySelector("#desktopScene");
const overlay = document.querySelector("#captureOverlay");
const store = createStore(createInitialState());
const capture = createCaptureController({
  root: desktopScene,
  overlay,
  selectionBox: document.querySelector("#selectionBox"),
  sizeLabel: document.querySelector("#selectionSize"),
  magnifier: document.querySelector("#magnifier"),
  toolbar: document.querySelector("#annotationToolbar")
}, store, () => DEFAULT_SETTINGS);

store.subscribe((state) => { app.dataset.mode = state.mode; });

function candidateRects() {
  const rootRect = desktopScene.getBoundingClientRect();
  return [...desktopScene.querySelectorAll("[data-window-candidate]")].map((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return { id: candidate.dataset.windowCandidate, x: rect.left - rootRect.left, y: rect.top - rootRect.top, width: rect.width, height: rect.height };
  });
}

capture.mount(candidateRects());
document.querySelector("#captureLauncher").addEventListener("click", () => capture.start());
