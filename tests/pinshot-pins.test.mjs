import assert from "node:assert/strict";
import test from "node:test";
import { changePinOpacity, clampPinPosition, createPin, createPinActions, fitPinToViewport, getPinDisplayGeometry, renderPins, resolvePinSource, scalePin, togglePinCollapse, togglePinLock } from "../public/pinshot/pins.mjs";

test("pin scale remains between 0.2 and 4", () => {
  const pin = createPin({ id: "p", width: 320, height: 180 });
  assert.equal(scalePin(pin, 99).scale, 4);
  assert.equal(scalePin(pin, -99).scale, 0.2);
});

test("pin opacity changes in five-point increments and clamps", () => {
  const pin = createPin({ id: "p", opacity: 98 });
  assert.equal(changePinOpacity(pin, 1).opacity, 100);
  assert.equal(changePinOpacity({ ...pin, opacity: 12 }, -1).opacity, 10);
});

test("lock and collapse are independent", () => {
  const pin = togglePinCollapse(togglePinLock(createPin({ id: "p" })));
  assert.equal(pin.locked, true);
  assert.equal(pin.collapsed, true);

});

function createFakeDom() {
  const nodes = new Map();
  const documentRef = {
    createElement() {
      const listeners = new Map();
      const classes = new Set();
      return {
        children: [], style: { _custom: new Map(), setProperty(name, value) { this._custom.set(name, String(value)); }, getPropertyValue(name) { return this._custom.get(name) || ""; } }, dataset: {}, attributes: {}, hidden: false, ownerDocument: documentRef,
        classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, listener) { listeners.set(type, listener); },
        closest(selector) { return selector === "button, a, input, select, textarea" && this.type === "button" ? this : null; },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name]; },
        setPointerCapture() {},
        emit(type, event = {}) {
          const value = { currentTarget: this, target: this, preventDefault() { value.prevented = true; }, ...event };
          listeners.get(type)?.(value);
          return value;
        }
      };
    },
    querySelector(selector) { return nodes.get(selector) || null; }
  };
  const pinLayer = documentRef.createElement("div");
  const historyStrip = documentRef.createElement("aside");
  nodes.set("#historyStrip", historyStrip);
  return { pinLayer, historyStrip };
}

const mouseActions = { pinScale: "Wheel", pinOpacity: "Ctrl+Wheel", closePin: "DoubleClick", resetPin: "MiddleClick", quickThumbnail: "Shift+DoubleClick", copyText: "Shift+RightClick" };
test("pin source prioritizes restored items, active selections, then latest history", () => {
  const restored = { id: "restored", selection: { x: 1, y: 2, width: 30, height: 20 }, imageBlob: { id: "restored-blob" } };
  const activeSelection = { x: 10, y: 20, width: 300, height: 180 };
  const latest = { id: "latest", selection: { x: 5, y: 6, width: 50, height: 40 }, imageBlob: { id: "latest-blob" } };

  assert.deepEqual(
    resolvePinSource({ restoredHistory: restored, selection: activeSelection, history: [latest] }),
    { selection: restored.selection, imageBlob: restored.imageBlob }
  );
  assert.deepEqual(
    resolvePinSource({ restoredHistory: null, selection: activeSelection, history: [latest] }),
    { selection: activeSelection, imageBlob: null }
  );
  assert.deepEqual(
    resolvePinSource({ restoredHistory: null, selection: null, history: [latest] }),
    { selection: latest.selection, imageBlob: latest.imageBlob }
  );
  assert.equal(resolvePinSource({ restoredHistory: null, selection: null, history: [] }), null);
});


test("rotated scaled pin geometry keeps state coordinates at the visible top-left", () => {
  const pin = { width: 200, height: 100, scale: 1.5, x: 780, y: 580 };
  const expected = new Map([
    [0, { width: 300, height: 150, translateX: 0, translateY: 0 }],
    [90, { width: 150, height: 300, translateX: 150, translateY: 0 }],
    [180, { width: 300, height: 150, translateX: 300, translateY: 150 }],
    [270, { width: 150, height: 300, translateX: 0, translateY: 300 }]
  ]);

  for (const [rotation, geometry] of expected) {
    assert.deepEqual(getPinDisplayGeometry({ ...pin, rotation }), geometry);
  }

  assert.deepEqual(
    clampPinPosition({ ...pin, rotation: 90 }, { width: 800, height: 600 }),
    { ...pin, rotation: 90, x: 650, y: 300 }
  );
});

test("initial pin geometry scales and clamps full-screen captures inside the pin viewport", () => {
  const viewport = { width: 1920, height: 1080 };
  const fullScreen = fitPinToViewport(createPin({ x: 80, y: 80, width: 1920, height: 1080 }), viewport, 12000);
  assert.deepEqual(fullScreen, createPin({ x: 0, y: 0, width: 1920, height: 1080 }));

  const oversized = fitPinToViewport(createPin({ x: 80, y: 80, width: 3840, height: 2160 }), viewport, 12000);
  assert.equal(oversized.scale, 0.5);
  assert.equal(oversized.x, 0);
  assert.equal(oversized.y, 0);
  assert.deepEqual(getPinDisplayGeometry(oversized), { width: 1920, height: 1080, translateX: 0, translateY: 0 });

  const settingsCapped = fitPinToViewport(createPin({ width: 16000, height: 8000 }), { width: 20000, height: 20000 }, 12000);
  assert.equal(settingsCapped.scale, 0.75);
  assert.deepEqual(getPinDisplayGeometry(settingsCapped), { width: 12000, height: 6000, translateX: 0, translateY: 0 });
});

test("rendered pin cards have position-independent Chinese names", () => {
  const { pinLayer } = createFakeDom();
  renderPins(pinLayer, [createPin({ id: "named" })], () => {}, { mouseActions });
  assert.equal(pinLayer.children[0].getAttribute("aria-label"), "\u8d34\u56fe 1");
});

test("pin image disables native image dragging", () => {
  const { pinLayer } = createFakeDom();
  renderPins(pinLayer, [createPin({ id: "image-drag" })], () => {}, { mouseActions });
  assert.equal(pinLayer.children[0].children[0].draggable, false);
});

test("image pointer drag moves an unlocked card while a locked card stays fixed", () => {
  const { pinLayer } = createFakeDom();
  const actions = [];
  renderPins(pinLayer, [createPin({ id: "image-move" })], (action) => actions.push(action), { mouseActions });
  const card = pinLayer.children[0];
  const image = card.children[0];
  card.emit("pointerdown", { target: image, button: 0, pointerId: 4, clientX: 100, clientY: 100 });
  card.emit("pointermove", { pointerId: 4, clientX: 125, clientY: 133 });
  card.emit("pointerup", { pointerId: 4 });
  assert.deepEqual(actions, [{ type: "PIN_UPDATE", id: "image-move", patch: { x: 105, y: 113 } }]);

  actions.length = 0;
  renderPins(pinLayer, [createPin({ id: "locked-image", locked: true })], (action) => actions.push(action), { mouseActions });
  const lockedCard = pinLayer.children[0];
  lockedCard.emit("pointerdown", { target: lockedCard.children[0], button: 0, pointerId: 5, clientX: 10, clientY: 10 });
  lockedCard.emit("pointermove", { pointerId: 5, clientX: 40, clientY: 40 });
  assert.deepEqual(actions, []);
});

test("pin drag and wheel routes dispatch pin updates while locked cards ignore drag", () => {
  const { pinLayer } = createFakeDom();
  const actions = [];
  renderPins(pinLayer, [createPin({ id: "movable" })], (action) => actions.push(action), { mouseActions });
  const card = pinLayer.children[0];
  card.emit("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  card.emit("pointermove", { pointerId: 1, clientX: 120, clientY: 130 });
  card.emit("pointerup", { pointerId: 1 });
  card.emit("wheel", { deltaY: -1 });
  card.emit("wheel", { deltaY: 1, ctrlKey: true });
  assert.deepEqual(actions.filter((action) => action.type === "PIN_UPDATE").map((action) => action.patch), [
    { x: 100, y: 110 }, { scale: 1.1 }, { opacity: 95 }
  ]);

  renderPins(pinLayer, [createPin({ id: "locked", locked: true })], (action) => actions.push(action), { mouseActions });
  pinLayer.children[0].emit("pointerdown", { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  pinLayer.children[0].emit("pointermove", { pointerId: 2, clientX: 40, clientY: 40 });
  assert.equal(actions.filter((action) => action.id === "locked").length, 0);
});

test("toolbar button pointer events bubble without starting a card drag", () => {
  const { pinLayer } = createFakeDom();
  pinLayer.clientWidth = 800;
  pinLayer.clientHeight = 600;
  const actions = [];
  renderPins(
    pinLayer,
    [createPin({ id: "toolbar", x: 780, y: 580, width: 200, height: 100, scale: 1.5 })],
    (action) => actions.push(action),
    { mouseActions }
  );

  const card = pinLayer.children[0];
  const rotate = card.children[1].children[1];
  card.emit("pointerdown", { target: rotate, button: 0, pointerId: 3, clientX: 100, clientY: 100 });
  card.emit("pointermove", { pointerId: 3, clientX: 120, clientY: 130 });
  rotate.emit("click");

  assert.deepEqual(actions, [{ type: "PIN_UPDATE", id: "toolbar", patch: { rotation: 90, x: 650, y: 300 } }]);
});

test("toolbar double-click and context-menu events do not run card gestures", () => {
  const { pinLayer } = createFakeDom();
  const actions = [];
  renderPins(pinLayer, [createPin({ id: "toolbar-boundary" })], (action) => actions.push(action), { mouseActions });
  const card = pinLayer.children[0];
  const copy = card.children[1].children[2];
  card.emit("dblclick", { target: copy });
  assert.deepEqual(actions, []);

  const rightClickSettings = { mouseActions: { ...mouseActions, closePin: "RightClick" } };
  renderPins(pinLayer, [createPin({ id: "toolbar-context" })], (action) => actions.push(action), rightClickSettings);
  const contextCard = pinLayer.children[0];
  const save = contextCard.children[1].children[3];
  contextCard.emit("contextmenu", { target: save });
  contextCard.emit("contextmenu", { target: save, shiftKey: true });
  assert.deepEqual(actions, []);
});

test("card and image double-click gestures remain available outside the toolbar", () => {
  const { pinLayer } = createFakeDom();
  const actions = [];
  renderPins(pinLayer, [createPin({ id: "card-gestures" })], (action) => actions.push(action), { mouseActions });
  const card = pinLayer.children[0];
  const image = card.children[0];

  card.emit("dblclick");
  assert.deepEqual(actions, [{ type: "PIN_REMOVE", id: "card-gestures" }]);

  actions.length = 0;
  card.emit("dblclick", { target: image });
  assert.deepEqual(actions, [{ type: "PIN_REMOVE", id: "card-gestures" }]);

  actions.length = 0;
  card.emit("dblclick", { shiftKey: true });
  assert.deepEqual(actions, [{ type: "PIN_UPDATE", id: "card-gestures", patch: { collapsed: true } }]);
});

test("rendered pins set CSS custom transform properties through CSSStyleDeclaration", () => {
  const { pinLayer } = createFakeDom();
  renderPins(
    pinLayer,
    [createPin({ id: "custom-properties", x: 150, y: 120, width: 200, height: 100, scale: 1.3, rotation: 90, opacity: 80 })],
    () => {},
    { mouseActions }
  );

  const style = pinLayer.children[0].style;
  assert.equal(style.left, "150px");
  assert.equal(style.getPropertyValue("--pin-translate-x"), "130px");
  assert.equal(style.getPropertyValue("--pin-translate-y"), "0px");
  assert.equal(style.getPropertyValue("--pin-scale"), "1.3");
  assert.equal(style.getPropertyValue("--pin-rotation"), "90deg");
});

test("pin rotation control clamps the new visible bounds inside its layer", () => {
  const { pinLayer } = createFakeDom();
  pinLayer.clientWidth = 800;
  pinLayer.clientHeight = 600;
  const actions = [];
  renderPins(
    pinLayer,
    [createPin({ id: "edge", x: 780, y: 580, width: 200, height: 100, scale: 1.5, rotation: 0 })],
    (action) => actions.push(action),
    { mouseActions }
  );

  const toolbar = pinLayer.children[0].children[1];
  toolbar.children[1].emit("click");

  assert.deepEqual(actions, [{ type: "PIN_UPDATE", id: "edge", patch: { rotation: 90, x: 650, y: 300 } }]);
});

test("configured right-click closes a pin while shift-right-click keeps copy-text priority", () => {
  const { pinLayer } = createFakeDom();
  const actions = [];
  const rightClickSettings = { mouseActions: { ...mouseActions, closePin: "RightClick" } };
  renderPins(pinLayer, [createPin({ id: "right-click" })], (action) => actions.push(action), rightClickSettings);
  const card = pinLayer.children[0];
  card.emit("dblclick");
  assert.equal(actions.length, 0);
  const closeEvent = card.emit("contextmenu");
  assert.equal(closeEvent.prevented, true);
  assert.deepEqual(actions, [{ type: "PIN_REMOVE", id: "right-click" }]);

  actions.length = 0;
  card.emit("contextmenu", { shiftKey: true });
  assert.equal(actions.some((action) => action.type === "PIN_REMOVE"), false);
  assert.equal(actions.some((action) => action.type === "TOAST_SHOW"), true);
});

test("pin history displays eight thumbnails and restores the selected item", () => {
  const { pinLayer, historyStrip } = createFakeDom();
  const actions = [];
  const history = Array.from({ length: 9 }, (_, index) => ({ id: `shot-${index}`, selection: { x: index, y: 0, width: 320, height: 180 } }));
  renderPins(pinLayer, [], (action) => actions.push(action), { mouseActions }, history);
  assert.equal(historyStrip.children.length, 8);
  historyStrip.children[0].emit("click");
  assert.deepEqual(actions, [{ type: "HISTORY_RESTORE", id: "shot-0" }]);
});
test("Blob URLs are revoked only after their previous nodes are removed", () => {
  const originalUrl = globalThis.URL;
  const events = [];
  let number = 0;
  globalThis.URL = {
    createObjectURL() { const value = `blob:test-${++number}`; events.push(`create:${value}`); return value; },
    revokeObjectURL(value) { events.push(`revoke:${value}`); }
  };
  try {
    const { pinLayer, historyStrip } = createFakeDom();
    const clear = (node, name) => {
      const replace = node.replaceChildren.bind(node);
      node.replaceChildren = (...children) => { events.push(`clear:${name}`); replace(...children); };
    };
    clear(pinLayer, "pins");
    clear(historyStrip, "history");
    renderPins(pinLayer, [createPin({ id: "p", imageBlob: {} })], () => {}, { mouseActions }, [{ id: "h", imageBlob: {} }]);
    events.length = 0;
    renderPins(pinLayer, [createPin({ id: "p", imageBlob: {} })], () => {}, { mouseActions }, [{ id: "h", imageBlob: {} }]);
    assert.ok(events.indexOf("clear:pins") < events.indexOf("revoke:blob:test-1"));
    assert.ok(events.indexOf("clear:history") < events.indexOf("revoke:blob:test-2"));
  } finally {
    globalThis.URL = originalUrl;
  }
});
test("pin copy and save controls use injected Blob actions and preserve the pin on failure", async () => {
  const { pinLayer } = createFakeDom();
  const blob = new Blob(["pin"], { type: "image/png" });
  const calls = [];
  const dispatched = [];
  renderPins(pinLayer, [createPin({ id: "p", imageBlob: blob })], (action) => dispatched.push(action), { mouseActions }, [], {
    actions: {
      copy: async (value) => calls.push(["copy", value]),
      save: async (value) => calls.push(["save", value])
    }
  });
  const controls = pinLayer.children[0].children[1].children;
  controls[2].emit("click");
  controls[3].emit("click");
  await new Promise(setImmediate);
  assert.deepEqual(calls, [["copy", blob], ["save", blob]]);

  renderPins(pinLayer, [createPin({ id: "p", imageBlob: blob })], (action) => dispatched.push(action), { mouseActions }, [], {
    actions: { copy: async () => { throw new Error("denied"); }, save: async () => { throw new Error("disk full"); } }
  });
  const failedControls = pinLayer.children[0].children[1].children;
  failedControls[2].emit("click");
  failedControls[3].emit("click");
  await new Promise(setImmediate);
  assert.equal(dispatched.filter((action) => action.type === "PIN_REMOVE").length, 0);
  assert.match(dispatched.find((action) => action.type === "TOAST_SHOW").message, /\u590d\u5236\u5931\u8d25.*\u8bf7\u4f7f\u7528\u4fdd\u5b58/);
});

test("injected pin actions write image clipboard data and always revoke download URLs", async () => {
  const blob = { type: "image/png" };
  const writes = [];
  const downloads = [];
  const revoked = [];
  class TestClipboardItem { constructor(value) { this.value = value; } }
  const actions = createPinActions({
    clipboard: { write: async (items) => writes.push(items) },
    ClipboardItemRef: TestClipboardItem,
    documentRef: { createElement: () => ({ click() { downloads.push("clicked"); } }) },
    URLRef: { createObjectURL: () => "blob:download", revokeObjectURL: (url) => revoked.push(url) },
    now: () => new Date("2026-08-01T08:09:07Z")
  });
  await actions.copy(blob);
  await actions.save(blob);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].value["image/png"], blob);
  assert.deepEqual(downloads, ["clicked"]);
  assert.deepEqual(revoked, ["blob:download"]);
  await assert.rejects(createPinActions({ clipboard: {}, ClipboardItemRef: TestClipboardItem }).copy(blob), /\u590d\u5236\u5931\u8d25.*\u8bf7\u4f7f\u7528\u4fdd\u5b58/);
});
