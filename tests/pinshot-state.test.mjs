import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, createStore, reducer } from "../public/pinshot/state.mjs";

test("capture lifecycle moves through selected and pinned states", () => {
  let state = createInitialState();
  state = reducer(state, { type: "CAPTURE_START" });
  assert.equal(state.mode, "capturing");
  state = reducer(state, { type: "SELECTION_SET", rect: { x: 40, y: 60, width: 320, height: 180 } });
  assert.equal(state.mode, "selected");
  state = reducer(state, { type: "PIN_CREATE", pin: { id: "pin-1", x: 60, y: 60, width: 320, height: 180 } });
  assert.equal(state.mode, "idle");
  assert.equal(state.pins.length, 1);
});

test("store notifies once per dispatched action", () => {
  const store = createStore(createInitialState());
  const modes = [];
  const unsubscribe = store.subscribe((state) => modes.push(state.mode));
  store.dispatch({ type: "CAPTURE_START" });
  unsubscribe();
  store.dispatch({ type: "CAPTURE_CANCEL" });
  assert.deepEqual(modes, ["capturing"]);
});

test("history keeps the newest eight captures", () => {
  let state = createInitialState();
  for (let index = 0; index < 10; index += 1) {
    state = reducer(state, { type: "HISTORY_ADD", item: { id: `shot-${index}`, createdAt: index } });
  }
  assert.equal(state.history.length, 8);
  assert.deepEqual(state.history.map((item) => item.id), ["shot-9","shot-8","shot-7","shot-6","shot-5","shot-4","shot-3","shot-2"]);
});

test("history restore reopens the stored selection and group actions remain immutable", () => {
  let state = createInitialState({
    pins: [
      { id: "default-pin", group: "default", hidden: false },
      { id: "reference-pin", group: "reference", hidden: false }
    ],
    history: [{ id: "shot-1", selection: { x: 8, y: 16, width: 320, height: 180 }, imageBlob: { type: "image/png" } }]
  });

  state = reducer(state, { type: "PIN_GROUP_TOGGLE", group: "default" });
  assert.equal(state.pins[0].hidden, true);
  assert.equal(state.pins[1].hidden, false);
  state = reducer(state, { type: "PIN_GROUP_CYCLE" });
  assert.equal(state.activePinGroup, "reference");
  state = reducer(state, { type: "HISTORY_RESTORE", id: "shot-1" });
  assert.equal(state.mode, "selected");
  assert.deepEqual(state.selection, { x: 8, y: 16, width: 320, height: 180 });
  assert.equal(state.restoredHistory.id, "shot-1");
});

test("annotation reducer actions retain immutable undo and redo snapshots", () => {
  let state = createInitialState();
  const initialHistory = state.annotations;
  state = reducer(state, { type: "ANNOTATION_COMMIT", annotation: { id: "note-1", type: "rectangle" } });
  assert.equal(state.mode, "annotating");
  assert.deepEqual(state.annotations.present.map((item) => item.id), ["note-1"]);
  assert.notEqual(state.annotations, initialHistory);
  state = reducer(state, { type: "ANNOTATION_UNDO" });
  assert.deepEqual(state.annotations.present, []);
  state = reducer(state, { type: "ANNOTATION_REDO" });
  assert.deepEqual(state.annotations.present.map((item) => item.id), ["note-1"]);
});
test("fresh capture and pin creation clear a previously restored history item", () => {
  const restored = { id: "old", selection: { x: 1, y: 2, width: 30, height: 20 }, imageBlob: { type: "image/png" } };
  let state = createInitialState({ restoredHistory: restored });
  state = reducer(state, { type: "CAPTURE_START" });
  assert.equal(state.restoredHistory, null);
  state = reducer({ ...state, restoredHistory: restored }, { type: "SELECTION_SET", rect: { x: 10, y: 10, width: 40, height: 30 } });
  assert.equal(state.restoredHistory, null);
  state = reducer({ ...state, restoredHistory: restored }, { type: "PIN_CREATE", pin: { id: "new-pin" } });
  assert.equal(state.restoredHistory, null);
});
