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

function updatePin(dispatch, pin, patch) {
  dispatch({ type: "PIN_UPDATE", id: pin.id, patch });
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

function attachPinEvents(card, pin, dispatch, settings) {
  let drag = null;
  card.addEventListener("pointerdown", (event) => {
    if (event.button === 1 && configuredAction(settings, "resetPin") === "MiddleClick") {
      event.preventDefault();
      updatePin(dispatch, pin, { scale: 1, opacity: 100, rotation: 0 });
      return;
    }
    if (event.button !== 0 || pin.locked) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    card.setPointerCapture?.(event.pointerId);
  });
  card.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId || pin.locked) return;
    updatePin(dispatch, pin, { x: pin.x + event.clientX - drag.x, y: pin.y + event.clientY - drag.y });
  });
  const clearDrag = () => { drag = null; };
  card.addEventListener("pointerup", clearDrag);
  card.addEventListener("pointercancel", clearDrag);
  card.addEventListener("wheel", (event) => {
    const direction = event.deltaY < 0 ? 1 : -1;
    if (event.ctrlKey && configuredAction(settings, "pinOpacity") === "Ctrl+Wheel") {
      event.preventDefault();
      updatePin(dispatch, pin, { opacity: changePinOpacity(pin, direction).opacity });
    } else if (!event.ctrlKey && configuredAction(settings, "pinScale") === "Wheel") {
      event.preventDefault();
      updatePin(dispatch, pin, { scale: scalePin(pin, direction).scale });
    }
  });
  card.addEventListener("dblclick", (event) => {
    if (event.shiftKey && configuredAction(settings, "quickThumbnail") === "Shift+DoubleClick") {
      updatePin(dispatch, pin, { collapsed: !pin.collapsed });
    } else if (!event.shiftKey && configuredAction(settings, "closePin") === "DoubleClick") {
      dispatch({ type: "PIN_REMOVE", id: pin.id });
    }
  });
  card.addEventListener("contextmenu", (event) => {
    if (event.shiftKey && configuredAction(settings, "copyText") === "Shift+RightClick") {
      event.preventDefault();
      dispatch({ type: "TOAST_SHOW", message: pin.recognizedText ? "\u5df2\u590d\u5236\u8bc6\u522b\u6587\u5b57" : "\u672a\u8bc6\u522b\u5230\u53ef\u590d\u5236\u6587\u5b57" });
    }
  });
}

export function renderPins(container, pins, dispatch, settings, history = [], { actions } = {}) {
  container.replaceChildren();
  revokeUrls(container);
  const documentRef = container.ownerDocument || document;
  for (let index = 0; index < pins.length; index += 1) {
    const pin = pins[index];
    if (pin.hidden) continue;
    const card = documentRef.createElement("article");
    card.className = "pin-card";
    card.dataset.pinId = pin.id;
    card.classList.toggle("is-locked", Boolean(pin.locked));
    card.classList.toggle("is-collapsed", Boolean(pin.collapsed));
    Object.assign(card.style, {
      left: `${pin.x}px`, top: `${pin.y}px`, width: `${pin.width}px`, height: `${pin.height}px`,
      "--card-opacity": String(pin.opacity / 100), transform: `scale(${pin.scale}) rotate(${pin.rotation}deg)`
    });
    const image = documentRef.createElement("img");
    image.alt = `\u8d34\u56fe ${index + 1}`;
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
      createControl(documentRef, "\u9501\u5b9a", () => updatePin(dispatch, pin, { locked: !pin.locked })),
      createControl(documentRef, "\u65cb\u8f6c", () => updatePin(dispatch, pin, { rotation: rotatePin(pin).rotation })),
      createControl(documentRef, "\u590d\u5236", () => runAction("copy")),
      createControl(documentRef, "\u4fdd\u5b58", () => runAction("save")),
      createControl(documentRef, "\u5173\u95ed", () => dispatch({ type: "PIN_REMOVE", id: pin.id }))
    );
    card.append(toolbar);
    attachPinEvents(card, pin, dispatch, settings);
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
