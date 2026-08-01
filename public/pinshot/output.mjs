import { drawDesktopScene } from "./scene.mjs";

export const COPY_FAILURE_MESSAGE = "\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u4f7f\u7528\u4fdd\u5b58";

export function buildDownloadName(date = new Date()) {
  const digits = (value) => String(value).padStart(2, "0");
  return `PinShot-${date.getUTCFullYear()}${digits(date.getUTCMonth() + 1)}${digits(date.getUTCDate())}-${digits(date.getUTCHours())}${digits(date.getUTCMinutes())}${digits(date.getUTCSeconds())}.png`;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error("无法生成 PNG")),
    "image/png"
  ));
}

export async function copyCanvas(canvas, clipboard = navigator.clipboard) {
  const blob = await canvasToBlob(canvas);
  if (!clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(COPY_FAILURE_MESSAGE);
  }
  try {
    await clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    throw new Error(COPY_FAILURE_MESSAGE);
  }
  return blob;
}

export async function downloadCanvas(canvas, documentRef = document) {
  const blob = await canvasToBlob(canvas);
  const link = documentRef.createElement("a");
  const url = URL.createObjectURL(blob);
  link.download = buildDownloadName();
  link.href = url;
  try {
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return blob;
}

export function createCompositeCanvas(annotationCanvas, selection, viewport, documentRef = document, drawScene = drawDesktopScene) {
  const canvas = documentRef.createElement("canvas");
  canvas.width = Math.round(selection.width);
  canvas.height = Math.round(selection.height);
  const ctx = canvas.getContext("2d");
  drawScene(ctx, { ...viewport, offsetX: selection.x, offsetY: selection.y });
  ctx.drawImage(annotationCanvas, 0, 0, annotationCanvas.width, annotationCanvas.height, 0, 0, canvas.width, canvas.height);
  return canvas;

}
function outputId() {
  return globalThis.crypto?.randomUUID?.() || `history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createOutputRunner({
  store,
  annotationCanvas,
  getViewport,
  documentRef,
  createComposite = createCompositeCanvas,
  output = { copyCanvas, downloadCanvas },
  idFactory = outputId,
  now = () => new Date(),
  closeCapture = () => store.dispatch({ type: "CAPTURE_CANCEL" })
}) {
  return async function runOutput(command) {
    const state = store.getState();
    if (!state.selection) return { ok: false, reason: "no-selection" };
    const composite = createComposite(annotationCanvas, state.selection, getViewport(), documentRef);
    try {
      const blob = command === "save"
        ? await output.downloadCanvas(composite, documentRef)
        : await output.copyCanvas(composite);
      const createdAt = now();
      store.dispatch({
        type: "HISTORY_ADD",
        item: {
          id: idFactory(),
          createdAt: createdAt.toISOString(),
          width: composite.width || Math.round(state.selection.width),
          height: composite.height || Math.round(state.selection.height),
          selection: { ...state.selection },
          imageBlob: blob
        }
      });
      closeCapture();
      store.dispatch({ type: "TOAST_SHOW", message: command === "save" ? "Screenshot saved" : "Image copied to clipboard" });
      return { ok: true, blob };
    } catch (error) {
      store.dispatch({ type: "TOAST_SHOW", message: command === "save" ? (error instanceof Error ? error.message : "Output failed; use Save") : COPY_FAILURE_MESSAGE });
      return { ok: false, error };
    }
  };
}
