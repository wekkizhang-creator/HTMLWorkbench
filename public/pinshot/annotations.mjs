import { normalizeRect } from "./geometry.mjs";

export function createAnnotationHistory() {
  return { past: [], present: [], future: [] };
}

export function commitAnnotation(history, annotation) {
  return {
    past: [...history.past, history.present],
    present: [...history.present, annotation],
    future: []
  };
}

export function undoAnnotation(history) {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past.at(-1),
    future: [history.present, ...history.future]
  };
}

export function redoAnnotation(history) {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1)
  };
}

export function annotationFromGesture(tool, start, end, style = {}) {
  const base = {
    ...(style.id ? { id: style.id } : {}),
    color: style.color || "#4C8DFF",
    strokeWidth: style.width || 3
  };
  if (tool === "pen" || tool === "highlight") {
    return { ...base, type: tool, points: style.points || [start, end], opacity: tool === "highlight" ? 0.35 : 1 };
  }
  if (tool === "rectangle" || tool === "mosaic") return { ...base, type: tool, ...normalizeRect(start, end) };
  if (tool === "arrow") return { ...base, type: tool, start, end };
  if (tool === "text") return { ...base, type: tool, x: start.x, y: start.y, text: style.text || "文字", fontSize: style.fontSize || 18 };
  if (tool === "number") return { ...base, type: tool, x: start.x, y: start.y, value: style.value || 1 };
  if (tool === "color") return { ...base, type: tool, x: start.x, y: start.y, value: style.value || "#4C8DFF" };
  throw new Error(`Unsupported annotation tool: ${tool}`);
}
