export function createInitialState(overrides = {}) {
  return {
    mode: "idle",
    selection: null,
    activeTool: "select",
    annotations: { past: [], present: [], future: [] },
    pins: [],
    history: [],
    settingsOpen: false,
    trayOpen: false,
    toast: null,
    ...overrides
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case "CAPTURE_START": return { ...state, mode: "capturing", selection: null, trayOpen: false };
    case "CAPTURE_CANCEL": return { ...state, mode: "idle", selection: null, annotations: { past: [], present: [], future: [] } };
    case "SELECTION_SET": return { ...state, mode: "selected", selection: { ...action.rect } };
    case "TOOL_SELECT": return { ...state, mode: "annotating", activeTool: action.tool };
    case "PIN_CREATE": return { ...state, mode: "idle", pins: [...state.pins, { opacity: 100, scale: 1, locked: false, collapsed: false, group: "default", ...action.pin }], selection: null };
    case "PIN_UPDATE": return { ...state, pins: state.pins.map((pin) => pin.id === action.id ? { ...pin, ...action.patch } : pin) };
    case "PIN_REMOVE": return { ...state, pins: state.pins.filter((pin) => pin.id !== action.id) };
    case "HISTORY_ADD": return { ...state, history: [action.item, ...state.history.filter((item) => item.id !== action.item.id)].slice(0, 8) };
    case "SETTINGS_OPEN": return { ...state, settingsOpen: true, trayOpen: false };
    case "SETTINGS_CLOSE": return { ...state, settingsOpen: false };
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
