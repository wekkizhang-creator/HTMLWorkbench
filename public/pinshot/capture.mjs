import { clampRect, findCandidate, normalizeRect, placeToolbar, resizeRect } from "./geometry.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function getToolbarPosition(selection, toolbar, bounds) {
  const measured = toolbar.getBoundingClientRect();
  const size = { width: measured.width || toolbar.offsetWidth || 200, height: measured.height || toolbar.offsetHeight || 48 };
  return placeToolbar(selection, size, bounds);
}

export function getMagnifierPosition(cursor, bounds, size = { width: 132, height: 104 }, gap = 20) {
  const maxX = Math.max(0, bounds.width - size.width);
  const maxY = Math.max(0, bounds.height - size.height);
  const preferredX = cursor.x + gap + size.width <= bounds.width
    ? cursor.x + gap
    : cursor.x - gap - size.width;
  const preferredY = cursor.y + gap + size.height <= bounds.height
    ? cursor.y + gap
    : cursor.y - gap - size.height;
  return {
    x: clamp(preferredX, 0, maxX),
    y: clamp(preferredY, 0, maxY)
  };
}

export function getSizeLabelPosition(selection, label, bounds, gap = 6) {
  const measured = label.getBoundingClientRect();
  const width = measured.width || label.offsetWidth || 82;
  const height = measured.height || label.offsetHeight || 24;
  const maxX = Math.max(0, bounds.width - width);
  const maxY = Math.max(0, bounds.height - height);
  const above = selection.y - height - gap;
  const below = selection.y + selection.height + gap;
  return {
    x: clamp(selection.x, 0, maxX),
    y: above >= 0 ? clamp(above, 0, maxY) : clamp(below, 0, maxY)
  };
}

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
    const magnifierSize = { width: elements.magnifier.offsetWidth || 132, height: elements.magnifier.offsetHeight || 104 };
    store.dispatch({ type: "CAPTURE_MAGNIFIER_SET", point: getSettings().showMagnifierBorder ? getMagnifierPosition(cursor, bounds(), magnifierSize) : null });
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
    store.dispatch({ type: "CAPTURE_TOOLBAR_SET", position: getToolbarPosition(rect, elements.toolbar, bounds()) });
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
