import { clampRect, findCandidate, normalizeRect, placeToolbar, resizeRect } from "./geometry.mjs";

export function createCaptureController(elements, store, getSettings) {
  let drag = null;
  let hoveredCandidate = null;
  let candidates = [];
  const bounds = () => ({ width: elements.root.clientWidth, height: elements.root.clientHeight });
  const point = (event) => {
    const rect = elements.root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const preview = (rect) => store.dispatch({ type: "CAPTURE_PREVIEW_SET", rect });

  function begin(event) {
    if (event.button !== 0) return;
    const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
    if (!handle && (event.target.closest?.("#annotationToolbar") || event.target.closest?.("#annotationCanvas") || event.target.closest?.(".annotation-text-input"))) return;
    const cursor = point(event);
    const state = store.getState();
    const candidate = state.capture.freeOnly ? null : (hoveredCandidate || findCandidate(cursor, candidates));
    const origin = state.selection || state.capture.preview;
    drag = handle && origin ? { kind: "resize", handle, origin } : candidate ? { kind: "candidate", rect: { ...candidate }, start: cursor } : { kind: "create", start: cursor };
    elements.overlay.setPointerCapture?.(event.pointerId);
  }

  function move(event) {
    const cursor = point(event);
    store.dispatch({ type: "CAPTURE_MAGNIFIER_SET", point: getSettings().showMagnifierBorder ? { x: cursor.x + 20, y: cursor.y + 20 } : null });
    if (!drag) {
      hoveredCandidate = store.getState().capture.freeOnly ? null : findCandidate(cursor, candidates);
      preview(hoveredCandidate);
      return;
    }
    if (drag.kind === "candidate") {
      if (Math.hypot(cursor.x - drag.start.x, cursor.y - drag.start.y) <= 4) { preview(drag.rect); return; }
      drag = { kind: "create", start: drag.start };
    }
    const rect = drag.kind === "resize" ? resizeRect(drag.origin, drag.handle, cursor, bounds()) : clampRect(normalizeRect(drag.start, cursor), bounds());
    preview(rect);
  }

  function end(event) {
    if (!drag) return;
    const cursor = point(event);
    const rect = drag.kind === "candidate" ? drag.rect : drag.kind === "resize" ? resizeRect(drag.origin, drag.handle, cursor, bounds()) : clampRect(normalizeRect(drag.start, cursor), bounds());
    drag = null;
    store.dispatch({ type: "SELECTION_SET", rect });
    const measured = elements.toolbar.getBoundingClientRect();
    const size = { width: measured.width || elements.toolbar.offsetWidth || 200, height: measured.height || elements.toolbar.offsetHeight || 48 };
    store.dispatch({ type: "CAPTURE_TOOLBAR_SET", position: placeToolbar(rect, size, bounds()) });
  }

  function cancel() {
    drag = null;
    hoveredCandidate = null;
    store.dispatch({ type: "CAPTURE_CANCEL" });
  }

  return {
    mount(candidateRects) {
      candidates = candidateRects;
      elements.overlay.addEventListener("pointerdown", begin);
      elements.overlay.addEventListener("pointermove", move);
      elements.overlay.addEventListener("pointerup", end);
      elements.overlay.addEventListener("pointercancel", cancel);
    },
    start(options = {}) {
      store.dispatch({ type: "CAPTURE_START", ...options });
      drag = null;
      hoveredCandidate = null;
    },
    cancel
  };
}
