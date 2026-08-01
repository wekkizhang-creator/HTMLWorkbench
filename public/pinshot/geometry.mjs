export function normalizeRect(start, end) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function clampRect(rect, bounds, minimum = 24) {
  const availableWidth = bounds.width - Math.max(0, rect.x);
  const availableHeight = bounds.height - Math.max(0, rect.y);
  const width = Math.min(bounds.width, Math.max(minimum, Math.min(rect.width, availableWidth)));
  const height = Math.min(bounds.height, Math.max(minimum, Math.min(rect.height, availableHeight)));
  return { x: Math.min(bounds.width - width, Math.max(0, rect.x)), y: Math.min(bounds.height - height, Math.max(0, rect.y)), width, height };
}

export function resizeRect(rect, handle, point, bounds) {
  const edges = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  if (handle.includes("w")) edges.left = point.x;
  if (handle.includes("e")) edges.right = point.x;
  if (handle.includes("n")) edges.top = point.y;
  if (handle.includes("s")) edges.bottom = point.y;
  return clampRect(normalizeRect({ x: edges.left, y: edges.top }, { x: edges.right, y: edges.bottom }), bounds);
}

export function findCandidate(point, candidates) {
  return candidates
    .filter((candidate) => point.x >= candidate.x && point.x <= candidate.x + candidate.width && point.y >= candidate.y && point.y <= candidate.y + candidate.height)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
}

export function placeToolbar(selection, toolbar, bounds, gap = 12) {
  const x = Math.min(bounds.width - toolbar.width, Math.max(0, selection.x));
  if (selection.y + selection.height + gap + toolbar.height <= bounds.height) return { x, y: selection.y + selection.height + gap, placement: "below" };
  if (selection.y - gap - toolbar.height >= 0) return { x, y: selection.y - gap - toolbar.height, placement: "above" };
  return { x, y: Math.max(0, selection.y + selection.height - toolbar.height - gap), placement: "inside" };
}
