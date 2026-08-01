import assert from "node:assert/strict";
import test from "node:test";
import { changePinOpacity, createPin, createPinActions, renderPins, scalePin, togglePinCollapse, togglePinLock } from "../public/pinshot/pins.mjs";

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
        children: [], style: {}, dataset: {}, attributes: {}, hidden: false, ownerDocument: documentRef,
        classList: { toggle(name, force) { force ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, listener) { listeners.set(type, listener); },
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
