import { annotationFromGesture } from "./annotations.mjs";

function line(ctx, points) {
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.stroke();
}

export function renderAnnotations(ctx, annotations) {
  ctx.save();
  ctx.setTransform?.(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
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
  let activeTextInput = null;
  let committed = [];

  function draw(items = committed) {
    renderAnnotations(canvas.getContext("2d"), items);
  }


  function finalizeActiveTextInput(commit = true, expected = activeTextInput) {
    const editor = expected;
    if (!editor || editor.finalized) return;
    editor.finalized = true;
    if (activeTextInput === editor) activeTextInput = null;
    const value = editor.element.value.trim();
    editor.element.remove();
    if (commit && value) {
      onCommit(annotationFromGesture("text", editor.point, editor.point, { ...getStyle(), text: value }));
    }
  }

  function startText(selection, point) {
    finalizeActiveTextInput();
    input = document.createElement("input");
    input.type = "text";
    input.className = "annotation-text-input";
    input.setAttribute("aria-label", "输入标注文字");
    input.setAttribute("aria-label", "输入标注文字");
    input.style.left = `${selection.x + point.x}px`;
    input.style.top = `${selection.y + point.y}px`;
    canvas.parentElement.append(input);
    input.focus();
    const editor = { element: input, point, finalized: false };
    input.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Enter") finalizeActiveTextInput(true, editor);
      if (keyEvent.key === "Escape") finalizeActiveTextInput(false, editor);
    });
    input.addEventListener("blur", () => finalizeActiveTextInput(true, editor), { once: true });
    activeTextInput = editor;
  }

  function pointerDown(event) {
    event.stopPropagation();
    const selection = getSelection();
    const tool = getTool();
    if (!selection || tool === "select") return;
    const point = localPoint(event, selection);
    if (tool === "text") return startText(selection, point);
    gesture = { tool, start: point, points: [point] };
    canvas.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!gesture) return;
    gesture.end = localPoint(event, getSelection());
    if (gesture.tool === "pen" || gesture.tool === "highlight") gesture.points.push(gesture.end);
    const preview = annotationFromGesture(gesture.tool, gesture.start, gesture.end, { ...getStyle(), points: gesture.points });
    draw([...committed, preview]);
  }

  function pointerUp(event) {
    if (!gesture) return;
    const end = localPoint(event, getSelection());
    const { tool, start, points } = gesture;
    gesture = null;
    const annotation = annotationFromGesture(tool, start, end, { ...getStyle(), points, id: crypto.randomUUID() });
    onCommit(annotation);
    draw();
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", () => { gesture = null; draw(); });

  return {
    hasActiveTextInput: () => Boolean(activeTextInput),
    cancelActiveTextInput: () => finalizeActiveTextInput(false),
    render(annotations) {
      const selection = getSelection();
      if (!selection) return;
      const ratio = Math.max(1, globalThis.devicePixelRatio || 1);
      canvas.style.width = `${selection.width}px`;
      canvas.style.height = `${selection.height}px`;
      canvas.width = Math.max(1, Math.round(selection.width * ratio));
      canvas.height = Math.max(1, Math.round(selection.height * ratio));
      const context = canvas.getContext("2d");
      context.setTransform?.(ratio, 0, 0, ratio, 0, 0);
      committed = [...annotations];
      draw();
    },
    destroy() {
      finalizeActiveTextInput(false);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
    }
  };
}
