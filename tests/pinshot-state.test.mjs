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
