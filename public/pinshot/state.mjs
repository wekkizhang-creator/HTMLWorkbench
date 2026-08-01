import { commitAnnotation, redoAnnotation, undoAnnotation } from "./annotations.mjs";
import { createPin, toggleGroupVisibility } from "./pins.mjs";

export function createInitialState(overrides = {}) {
  return {
    mode: "idle",
    selection: null,
    activeTool: "select",
    annotations: { past: [], present: [], future: [] },
    pins: [],
    history: [],
    activePinGroup: "default",
    restoredHistory: null,
    settingsOpen: false,
    trayOpen: false,
    capture: { active: false, freeOnly: false, autoCopy: false, pendingAutoCopy: false, preview: null, magnifier: null, toolbarPosition: null },
    toast: null,
    ...overrides
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case "CAPTURE_START": return { ...state, mode: "capturing", selection: null, restoredHistory: null, trayOpen: false, capture: { active: true, freeOnly: Boolean(action.freeOnly), autoCopy: Boolean(action.autoCopy), pendingAutoCopy: false, preview: null, magnifier: null, toolbarPosition: null } };
    case "CAPTURE_CANCEL": return { ...state, mode: "idle", selection: null, annotations: { past: [], present: [], future: [] }, capture: { ...state.capture, active: false, freeOnly: false, autoCopy: false, pendingAutoCopy: false, preview: null, magnifier: null, toolbarPosition: null } };
    case "CAPTURE_PREVIEW_SET": return { ...state, capture: { ...state.capture, preview: action.rect ? { ...action.rect } : null } };
    case "CAPTURE_MAGNIFIER_SET": return { ...state, capture: { ...state.capture, magnifier: action.point ? { ...action.point } : null } };
    case "CAPTURE_TOOLBAR_SET": return { ...state, capture: { ...state.capture, toolbarPosition: action.position ? { ...action.position } : null } };
    case "CAPTURE_AUTO_COPY_CONSUME": return { ...state, capture: { ...state.capture, pendingAutoCopy: false, autoCopy: false } };
    case "SELECTION_SET": return { ...state, mode: "selected", selection: { ...action.rect }, restoredHistory: null, capture: { ...state.capture, preview: { ...action.rect }, pendingAutoCopy: state.capture.autoCopy } };
    case "TOOL_SELECT": return { ...state, mode: "annotating", activeTool: action.tool };
    case "ANNOTATION_COMMIT": return { ...state, mode: "annotating", annotations: commitAnnotation(state.annotations, action.annotation) };
    case "TOOL_CLEAR": return { ...state, mode: state.selection ? "selected" : "idle", activeTool: "select" };
    case "ANNOTATION_UNDO": return { ...state, annotations: undoAnnotation(state.annotations) };
    case "ANNOTATION_REDO": return { ...state, annotations: redoAnnotation(state.annotations) };
    case "PIN_CREATE": return { ...state, mode: "idle", pins: [...state.pins, createPin(action.pin)], selection: null, restoredHistory: null };
    case "PIN_UPDATE": return { ...state, pins: state.pins.map((pin) => pin.id === action.id ? { ...pin, ...action.patch } : pin) };
    case "PIN_REMOVE": return { ...state, pins: state.pins.filter((pin) => pin.id !== action.id) };
    case "HISTORY_ADD": return { ...state, history: [action.item, ...state.history.filter((item) => item.id !== action.item.id)].slice(0, 8) };
    case "SETTINGS_OPEN": return { ...state, settingsOpen: true, trayOpen: false };
    case "SETTINGS_CLOSE": return { ...state, settingsOpen: false };
    case "PIN_GROUP_TOGGLE": return { ...state, pins: toggleGroupVisibility(state.pins, action.group || "default") };
    case "PIN_GROUP_CYCLE": {
      const groups = ["default", "reference", "temporary"];
      const next = groups[(groups.indexOf(state.activePinGroup) + 1) % groups.length];
      return { ...state, activePinGroup: next };
    }
    case "HISTORY_RESTORE": {
      const item = state.history.find((historyItem) => historyItem.id === action.id);
      return item ? { ...state, mode: "selected", selection: { ...item.selection }, restoredHistory: item } : state;
    }
    case "TRAY_TOGGLE": return { ...state, trayOpen: !state.trayOpen };
    case "TOAST_SHOW": return { ...state, toast: action.message };
    case "TOAST_CLEAR": return { ...state, toast: null };
    default: return state;
  }
}

export function createStore(initialState, reduce = reducer) {
  let current = initialState;
  const listeners = new Set();
  return {
    getState: () => current,
    dispatch(action) {
      current = reduce(current, action);
      listeners.forEach((listener) => listener(current, action));
      return action;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
