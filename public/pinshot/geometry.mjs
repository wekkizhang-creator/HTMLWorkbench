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
  const base = clampRect(rect, bounds);
  let left = base.x;
  let top = base.y;
  let right = base.x + base.width;
  let bottom = base.y + base.height;
  if (handle.includes("w")) left = Math.min(right - 24, Math.max(0, point.x));
  if (handle.includes("e")) right = Math.max(left + 24, Math.min(bounds.width, point.x));
  if (handle.includes("n")) top = Math.min(bottom - 24, Math.max(0, point.y));
  if (handle.includes("s")) bottom = Math.max(top + 24, Math.min(bounds.height, point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
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
