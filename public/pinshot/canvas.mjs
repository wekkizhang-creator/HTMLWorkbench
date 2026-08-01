import { annotationFromGesture } from "./annotations.mjs";

function line(ctx, points) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();
}

export function renderAnnotations(ctx, annotations) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const item of annotations) {
    ctx.save();
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = item.strokeWidth || 3;
    ctx.globalAlpha = item.opacity ?? 1;
    if (item.type === "rectangle") ctx.strokeRect(item.x, item.y, item.width, item.height);
    if (item.type === "pen" || item.type === "highlight") line(ctx, item.points);
    if (item.type === "arrow") {
      line(ctx, [item.start, item.end]);
      const angle = Math.atan2(item.end.y - item.start.y, item.end.x - item.start.x);
      ctx.beginPath();
      ctx.moveTo(item.end.x, item.end.y);
      ctx.lineTo(item.end.x - 14 * Math.cos(angle - .45), item.end.y - 14 * Math.sin(angle - .45));
      ctx.lineTo(item.end.x - 14 * Math.cos(angle + .45), item.end.y - 14 * Math.sin(angle + .45));
      ctx.closePath();
      ctx.fill();
    }
    if (item.type === "text") {
      ctx.font = `${item.fontSize}px "Segoe UI Variable","Microsoft YaHei UI",sans-serif`;
      ctx.fillText(item.text, item.x, item.y);
    }
    if (item.type === "number") {
      ctx.beginPath();
      ctx.arc(item.x, item.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(item.value), item.x, item.y);
    }
    if (item.type === "mosaic") {
      ctx.fillStyle = "rgba(23,26,31,.6)";
      for (let y = item.y; y < item.y + item.height; y += 10) {
        for (let x = item.x; x < item.x + item.width; x += 10) {
          if (((x + y) / 10) % 2 === 0) ctx.fillRect(x, y, 10, 10);
        }
      }
    }
    if (item.type === "color") {
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(item.x - 10, item.y - 10, 20, 20);
    }
    ctx.restore();
  }
}

function localPoint(event, selection) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

export function createCanvasController({ canvas, getSelection, getTool, getStyle, onCommit }) {
  let gesture = null;
  let input = null;

  function finishText(point) {
    const value = input?.value.trim();
    input?.remove();
    input = null;
    if (value) onCommit(annotationFromGesture("text", point, point, { ...getStyle(), text: value }));
  }

  function startText(event, point) {
    input?.remove();
    input = document.createElement("input");
    input.type = "text";
    input.className = "annotation-text-input";
    input.setAttribute("aria-label", "输入标注文字");
    input.style.left = `${point.x}px`;
    input.style.top = `${point.y}px`;
    canvas.parentElement.append(input);
    input.focus();
    input.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Enter") finishText(point);
      if (keyEvent.key === "Escape") { input.remove(); input = null; }
    });
    input.addEventListener("blur", () => finishText(point), { once: true });
  }

  function pointerDown(event) {
    event.stopPropagation();
    const selection = getSelection();
    const tool = getTool();
    if (!selection || tool === "select") return;
    const point = localPoint(event, selection);
    if (tool === "text") return startText(event, point);
    gesture = { tool, start: point, points: [point] };
    canvas.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!gesture) return;
    gesture.end = localPoint(event, getSelection());
    if (gesture.tool === "pen" || gesture.tool === "highlight") gesture.points.push(gesture.end);
  }

  function pointerUp(event) {
    if (!gesture) return;
    const end = localPoint(event, getSelection());
    const { tool, start, points } = gesture;
    gesture = null;
    const annotation = annotationFromGesture(tool, start, end, { ...getStyle(), points, id: crypto.randomUUID() });
    onCommit(annotation);
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", () => { gesture = null; });

  return {
    render(annotations) {
      const selection = getSelection();
      if (!selection) return;
      canvas.width = Math.max(1, Math.round(selection.width));
      canvas.height = Math.max(1, Math.round(selection.height));
      renderAnnotations(canvas.getContext("2d"), annotations);
    },
    destroy() {
      input?.remove();
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
    }
  };
}
