import { buildDownloadName, COPY_FAILURE_MESSAGE } from "./output.mjs";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createPin(input = {}) {
  return {
    x: 80,
    y: 80,
    width: 320,
    height: 180,
    scale: 1,
    opacity: 100,
    locked: false,
    collapsed: false,
    hidden: false,
    group: "default",
    rotation: 0,
    ...input
  };
}

export function resolvePinSource(state) {
  const restored = state.restoredHistory;
  if (restored) return { selection: restored.selection, imageBlob: restored.imageBlob };
  if (state.selection) return { selection: state.selection, imageBlob: null };
  const latest = state.history?.[0];
  return latest ? { selection: latest.selection, imageBlob: latest.imageBlob } : null;
}

function normalizedRotation(rotation) {
  return ((Math.round(Number(rotation || 0) / 90) * 90) % 360 + 360) % 360;
}

export function getPinDisplayGeometry(pin) {
  const scale = Number(pin.scale || 1);
  const baseWidth = Math.max(0, Number(pin.width || 0) * scale);
  const baseHeight = Math.max(0, Number(pin.height || 0) * scale);
  const rotation = normalizedRotation(pin.rotation);
  if (rotation === 90) return { width: baseHeight, height: baseWidth, translateX: baseHeight, translateY: 0 };
  if (rotation === 180) return { width: baseWidth, height: baseHeight, translateX: baseWidth, translateY: baseHeight };
  if (rotation === 270) return { width: baseHeight, height: baseWidth, translateX: 0, translateY: baseWidth };
  return { width: baseWidth, height: baseHeight, translateX: 0, translateY: 0 };
}

export function clampPinPosition(pin, viewport) {
  if (!Number.isFinite(viewport?.width) || !Number.isFinite(viewport?.height)) return { ...pin };
  const geometry = getPinDisplayGeometry(pin);
  return {
    ...pin,
    x: clamp(Number(pin.x || 0), 0, Math.max(0, viewport.width - geometry.width)),
    y: clamp(Number(pin.y || 0), 0, Math.max(0, viewport.height - geometry.height))
  };
}

export function fitPinToViewport(pin, viewport, maxSize) {
  const viewportWidth = Number(viewport?.width);
  const viewportHeight = Number(viewport?.height);
  const pinWidth = Number(pin?.width);
  const pinHeight = Number(pin?.height);
  const finiteMaxSize = Number(maxSize);
  const unlimitedMaxSize = maxSize === Number.POSITIVE_INFINITY;
  if (
    !Number.isFinite(viewportWidth) || viewportWidth <= 0 ||
    !Number.isFinite(viewportHeight) || viewportHeight <= 0 ||
    !Number.isFinite(pinWidth) || pinWidth <= 0 ||
    !Number.isFinite(pinHeight) || pinHeight <= 0 ||
    (!unlimitedMaxSize && (!Number.isFinite(finiteMaxSize) || finiteMaxSize <= 0))
  ) return null;
  const baseGeometry = getPinDisplayGeometry({ ...pin, width: pinWidth, height: pinHeight, scale: 1 });
  const limits = [
    viewportWidth / baseGeometry.width,
    viewportHeight / baseGeometry.height,
    unlimitedMaxSize ? Infinity : finiteMaxSize / baseGeometry.width,
    unlimitedMaxSize ? Infinity : finiteMaxSize / baseGeometry.height
  ];
  const scale = Math.min(Number(pin.scale || 1), ...limits);
  return clampPinPosition({ ...pin, width: pinWidth, height: pinHeight, scale: Number.isFinite(scale) && scale > 0 ? scale : Number(pin.scale || 1) }, { width: viewportWidth, height: viewportHeight });
}

export function scalePin(pin, direction) {
  return { ...pin, scale: clamp(Number((pin.scale + direction * 0.1).toFixed(1)), 0.2, 4) };
}

export function changePinOpacity(pin, direction) {
  return { ...pin, opacity: clamp(pin.opacity + direction * 5, 10, 100) };
}

export function togglePinLock(pin) {
  return { ...pin, locked: !pin.locked };
}

export function togglePinCollapse(pin) {
  return { ...pin, collapsed: !pin.collapsed };
}
export function createPinActions({ clipboard, ClipboardItemRef, documentRef, URLRef, now = () => new Date() } = {}) {
  return {
    async copy(blob) {
      if (!blob || !clipboard?.write || typeof ClipboardItemRef !== "function") throw new Error(COPY_FAILURE_MESSAGE);
      try {
        await clipboard.write([new ClipboardItemRef({ "image/png": blob })]);
      } catch {
        throw new Error(COPY_FAILURE_MESSAGE);
      }
    },
    async save(blob) {
      if (!blob || !documentRef?.createElement || !URLRef?.createObjectURL || !URLRef?.revokeObjectURL) throw new Error("\u65e0\u6cd5\u4fdd\u5b58\u8d34\u56fe");
      const link = documentRef.createElement("a");
      const url = URLRef.createObjectURL(blob);
      link.download = buildDownloadName(now());
      link.href = url;
      try {
        link.click();
      } finally {
        URLRef.revokeObjectURL(url);
      }
    }
  };
}



const urlRegistry = new WeakMap();

function rememberUrl(container, blob) {
  if (!blob || typeof URL?.createObjectURL !== "function") return "";
  const url = URL.createObjectURL(blob);
  const urls = urlRegistry.get(container) || new Set();
  urls.add(url);
  urlRegistry.set(container, urls);
  return url;
}

function revokeUrls(container) {
  for (const url of urlRegistry.get(container) || []) URL.revokeObjectURL?.(url);
  urlRegistry.delete(container);
}

function containerViewport(container) {
  const width = Number(container?.clientWidth);
  const height = Number(container?.clientHeight);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : null;
}

function updatePin(dispatch, pin, patch, viewport) {
  const candidate = { ...pin, ...patch };
  const bounded = clampPinPosition(candidate, viewport);
  const nextPatch = { ...patch };
  if (bounded.x !== candidate.x) nextPatch.x = bounded.x;
  if (bounded.y !== candidate.y) nextPatch.y = bounded.y;
  dispatch({ type: "PIN_UPDATE", id: pin.id, patch: nextPatch });
}

function configuredAction(settings, name) {
  return settings?.mouseActions?.[name] || "";
}

function createControl(documentRef, label, onClick) {
  const button = documentRef.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function attachPinEvents(card, pin, dispatch, settings, viewport) {
  let drag = null;
  card.addEventListener("pointerdown", (event) => {
    if (event.target?.closest?.("button, a, input, select, textarea")) return;
    if (event.button === 1 && configuredAction(settings, "resetPin") === "MiddleClick") {
      event.preventDefault();
      updatePin(dispatch, pin, { scale: 1, opacity: 100, rotation: 0 }, viewport);
      return;
    }
    if (event.button !== 0 || pin.locked) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    card.setPointerCapture?.(event.pointerId);
  });
  card.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId || pin.locked) return;
    updatePin(dispatch, pin, { x: pin.x + event.clientX - drag.x, y: pin.y + event.clientY - drag.y }, viewport);
  });
  const clearDrag = () => { drag = null; };
  card.addEventListener("pointerup", clearDrag);
  card.addEventListener("pointercancel", clearDrag);
  card.addEventListener("wheel", (event) => {
    const direction = event.deltaY < 0 ? 1 : -1;
    if (event.ctrlKey && configuredAction(settings, "pinOpacity") === "Ctrl+Wheel") {
      event.preventDefault();
      updatePin(dispatch, pin, { opacity: changePinOpacity(pin, direction).opacity }, viewport);
    } else if (!event.ctrlKey && configuredAction(settings, "pinScale") === "Wheel") {
      event.preventDefault();
      updatePin(dispatch, pin, { scale: scalePin(pin, direction).scale }, viewport);
    }
  });
  card.addEventListener("dblclick", (event) => {
    if (event.target?.closest?.("button, a, input, select, textarea")) return;
    if (event.shiftKey && configuredAction(settings, "quickThumbnail") === "Shift+DoubleClick") {
      updatePin(dispatch, pin, { collapsed: !pin.collapsed }, viewport);
    } else if (!event.shiftKey && configuredAction(settings, "closePin") === "DoubleClick") {
      dispatch({ type: "PIN_REMOVE", id: pin.id });
    }
  });
  card.addEventListener("contextmenu", (event) => {
    if (event.target?.closest?.("button, a, input, select, textarea")) return;
    if (event.shiftKey && configuredAction(settings, "copyText") === "Shift+RightClick") {
      event.preventDefault();
      dispatch({ type: "TOAST_SHOW", message: pin.recognizedText ? "\u5df2\u590d\u5236\u8bc6\u522b\u6587\u5b57" : "\u672a\u8bc6\u522b\u5230\u53ef\u590d\u5236\u6587\u5b57" });
    } else if (!event.shiftKey && configuredAction(settings, "closePin") === "RightClick") {
      event.preventDefault();
      dispatch({ type: "PIN_REMOVE", id: pin.id });
    }
  });
}

export function renderPins(container, pins, dispatch, settings, history = [], { actions } = {}) {
  container.replaceChildren();
  revokeUrls(container);
  const documentRef = container.ownerDocument || document;
  const viewport = containerViewport(container);
  for (let index = 0; index < pins.length; index += 1) {
    const pin = pins[index];
    if (pin.hidden) continue;
    const geometry = getPinDisplayGeometry(pin);
    const card = documentRef.createElement("article");
    card.className = "pin-card";
    card.dataset.pinId = pin.id;
    card.setAttribute("aria-label", `\u8d34\u56fe ${index + 1}`);
    card.classList.toggle("is-locked", Boolean(pin.locked));
    card.classList.toggle("is-collapsed", Boolean(pin.collapsed));
    Object.assign(card.style, {
      left: `${pin.x}px`, top: `${pin.y}px`, width: `${pin.width}px`, height: `${pin.height}px`,
    });
    card.style.setProperty("--card-opacity", String(pin.opacity / 100));
    card.style.setProperty("--pin-translate-x", `${geometry.translateX}px`);
    card.style.setProperty("--pin-translate-y", `${geometry.translateY}px`);
    card.style.setProperty("--pin-scale", String(pin.scale));
    card.style.setProperty("--pin-rotation", `${normalizedRotation(pin.rotation)}deg`);
    const image = documentRef.createElement("img");
    image.alt = `\u8d34\u56fe ${index + 1}`;
    image.draggable = false;
    image.src = pin.imageUrl || rememberUrl(container, pin.imageBlob);
    card.append(image);
    const toolbar = documentRef.createElement("div");
    toolbar.className = "pin-card__toolbar";
    const runAction = (name) => {
      const operation = actions?.[name];
      if (!operation) {
        dispatch({ type: "TOAST_SHOW", message: name === "copy" ? COPY_FAILURE_MESSAGE : "\u65e0\u6cd5\u4fdd\u5b58\u8d34\u56fe" });
        return;
      }
      void operation(pin.imageBlob).catch((error) => dispatch({
        type: "TOAST_SHOW",
        message: name === "copy" ? COPY_FAILURE_MESSAGE : (error instanceof Error ? error.message : "\u65e0\u6cd5\u4fdd\u5b58\u8d34\u56fe")
      }));
    };

    toolbar.append(
      createControl(documentRef, "\u9501\u5b9a", () => updatePin(dispatch, pin, { locked: !pin.locked }, viewport)),
      createControl(documentRef, "\u65cb\u8f6c", () => updatePin(dispatch, pin, { rotation: rotatePin(pin).rotation }, viewport)),
      createControl(documentRef, "\u590d\u5236", () => runAction("copy")),
      createControl(documentRef, "\u4fdd\u5b58", () => runAction("save")),
      createControl(documentRef, "\u5173\u95ed", () => dispatch({ type: "PIN_REMOVE", id: pin.id }))
    );
    card.append(toolbar);
    attachPinEvents(card, pin, dispatch, settings, viewport);
    container.append(card);
  }
  const historyStrip = documentRef.querySelector?.("#historyStrip");
  if (!historyStrip) return;
  historyStrip.replaceChildren();
  revokeUrls(historyStrip);
  historyStrip.hidden = history.length === 0;
  history.slice(0, 8).forEach((item, index) => {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.title = `\u6700\u8fd1\u622a\u56fe ${index + 1}`;
    button.setAttribute("aria-label", `\u6062\u590d\u6700\u8fd1\u622a\u56fe ${index + 1}`);
    const image = documentRef.createElement("img");
    image.alt = `\u6700\u8fd1\u622a\u56fe ${index + 1}`;
    image.src = item.imageUrl || rememberUrl(historyStrip, item.imageBlob);
    button.append(image);
    button.addEventListener("click", () => dispatch({ type: "HISTORY_RESTORE", id: item.id }));
    historyStrip.append(button);
  });
}

export function rotatePin(pin) {
  return { ...pin, rotation: (pin.rotation + 90) % 360 };
}

export function toggleGroupVisibility(pins, group = "default") {
  const visible = pins.some((pin) => pin.group === group && !pin.hidden);
  return pins.map((pin) => pin.group === group ? { ...pin, hidden: visible } : pin);
}
