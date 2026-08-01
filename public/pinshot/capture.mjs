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

  function renderRect(rect) {
    Object.assign(elements.selectionBox.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    elements.selectionBox.hidden = false;
    elements.sizeLabel.hidden = false;
    elements.sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    Object.assign(elements.sizeLabel.style, { left: `${rect.x}px`, top: `${Math.max(0, rect.y - 30)}px` });
  }

  function begin(event) {
    if (event.button !== 0) return;
    const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
    const cursor = point(event);
    const candidate = hoveredCandidate || findCandidate(cursor, candidates);
    drag = handle
      ? { kind: "resize", handle, origin: store.getState().selection }
      : candidate
        ? { kind: "candidate", rect: { ...candidate }, start: cursor }
        : { kind: "create", start: cursor };
    elements.overlay.setPointerCapture?.(event.pointerId);
  }

  function move(event) {
    const cursor = point(event);
    elements.magnifier.hidden = !getSettings().showMagnifierBorder;
    Object.assign(elements.magnifier.style, { left: `${cursor.x + 20}px`, top: `${cursor.y + 20}px` });
    if (!drag) {
      hoveredCandidate = findCandidate(cursor, candidates);
      if (hoveredCandidate) renderRect(hoveredCandidate);
      return;
    }
    if (drag.kind === "candidate") {
      if (Math.hypot(cursor.x - drag.start.x, cursor.y - drag.start.y) <= 4) {
        renderRect(drag.rect);
        return;
      }
      drag = { kind: "create", start: drag.start };
    }
    const rect = drag.kind === "resize"
      ? resizeRect(drag.origin, drag.handle, cursor, bounds())
      : clampRect(normalizeRect(drag.start, cursor), bounds());
    renderRect(rect);
  }

  function end(event) {
    if (!drag) return;
    const cursor = point(event);
    const rect = drag.kind === "candidate"
      ? drag.rect
      : drag.kind === "resize"
        ? resizeRect(drag.origin, drag.handle, cursor, bounds())
        : clampRect(normalizeRect(drag.start, cursor), bounds());
    drag = null;
    store.dispatch({ type: "SELECTION_SET", rect });
    renderRect(rect);
    const position = placeToolbar(rect, { width: elements.toolbar.offsetWidth, height: 48 }, bounds());
    Object.assign(elements.toolbar.style, { left: `${position.x}px`, top: `${position.y}px` });
    elements.toolbar.hidden = false;
  }

  return {
    mount(candidateRects) {
      candidates = candidateRects;
      elements.overlay.addEventListener("pointerdown", begin);
      elements.overlay.addEventListener("pointermove", move);
      elements.overlay.addEventListener("pointerup", end);
    },
    start() {
      elements.overlay.hidden = false;
      store.dispatch({ type: "CAPTURE_START" });
    },
    cancel() {
      elements.overlay.hidden = true;
      elements.selectionBox.hidden = true;
      elements.sizeLabel.hidden = true;
      elements.magnifier.hidden = true;
      elements.toolbar.hidden = true;
      store.dispatch({ type: "CAPTURE_CANCEL" });
    }
  };
}
