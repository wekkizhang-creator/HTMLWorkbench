# PinShot Interactive Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-fidelity, browser-based PC screenshot-tool prototype that demonstrates capture, annotation, copy/save, desktop pinning, recent history, and settings without altering the existing HTMLWorkbench product flow.

**Architecture:** Add PinShot as an isolated static entry at `/pinshot.html`, backed by focused browser ES modules under `public/pinshot/`. Pure state, geometry, annotation, settings, history, and keyboard contracts remain DOM-independent and are covered by Node's built-in test runner; thin view controllers render the simulated desktop, selection overlay, canvas annotations, pinned cards, and settings window.

**Tech Stack:** Node.js 20+, existing CommonJS HTTP server, semantic HTML, modern CSS, browser ES modules (`.mjs`), Canvas 2D, Web Clipboard/Blob APIs with download fallback, browser `localStorage`, `node:test`, `node:assert/strict`.

## Global Constraints

- Preserve the existing HTMLWorkbench root page, authentication, upload APIs, storage behavior, and styles.
- Add no runtime or development dependency; use only platform APIs and the repository's existing Node 20+ runtime.
- The first-stage artifact is a high-fidelity prototype: it must explicitly state that it does not capture the real operating-system screen, register global shortcuts, or create native always-on-top windows.
- Keep screenshot content and settings local; the PinShot modules must perform no `fetch`, `XMLHttpRequest`, `WebSocket`, or remote asset request.
- Use the approved colors exactly: graphite `#171A1F`, blue `#4C8DFF`, mint `#2FC79A`, coral `#F25F5C`, light surface `#F6F7F9`, white `#FFFFFF`, text `#20242B`, muted text `#69707D`.
- Use `Segoe UI Variable`, `Microsoft YaHei UI`, and system sans-serif fallbacks; body text is 14px, helper text is 12px, setting-page titles are 22px, toolbar icons are 20px, and interactive targets are at least 36 × 36px.
- The capture toolbar is 48px high; the settings window targets 860 × 620px with a 176px left navigation.
- The recent-history limit is exactly 8 screenshots.
- Default keyboard bindings are `F1`, `Ctrl+F1`, `Shift+F1`, `F3`, `Shift+F3`, `Ctrl+F3`, `Enter`, `Escape`, `Ctrl+Z`, and `Ctrl+Shift+Z` as specified in the approved design.
- Every icon-only button has a Chinese accessible name and visible tooltip; keyboard focus remains visible; color is never the sole state signal.
- Respect `prefers-reduced-motion: reduce` and maintain usable layouts at 1366 × 768, 1440 × 900, and 1920 × 1080.

## File Structure

| File | Responsibility |
| --- | --- |
| `public/pinshot.html` | Semantic PinShot shell, simulated desktop, capture overlay, annotation toolbar, history strip, settings dialog, prototype limitation notice |
| `public/pinshot/styles.css` | Approved visual tokens, desktop scene, overlay, toolbar, pin cards, settings layout, themes, responsive and reduced-motion rules |
| `public/pinshot/app.mjs` | Application composition, DOM lookup, state subscription, mode rendering, command routing, toast feedback |
| `public/pinshot/state.mjs` | Immutable top-level state, reducer, action contracts, tiny observable store |
| `public/pinshot/geometry.mjs` | Rectangle normalization/clamping/resizing, coordinate conversion, candidate hit-testing, toolbar placement |
| `public/pinshot/capture.mjs` | Pointer-driven selection controller, window candidates, resize-handle controller, magnifier and size-label updates |
| `public/pinshot/annotations.mjs` | Annotation data model, gesture-to-annotation conversion, undo/redo history |
| `public/pinshot/canvas.mjs` | Canvas sizing, annotation rendering, tool preview, text editing, mosaic and color sampling |
| `public/pinshot/scene.mjs` | Deterministic Canvas 2D rendering of the simulated desktop used by PNG output |
| `public/pinshot/output.mjs` | Composite rendering, clipboard write, PNG download, deterministic file naming |
| `public/pinshot/pins.mjs` | Pinned-card state transforms, scaling, opacity, locking, collapse/restore, grouping and DOM controller |
| `public/pinshot/settings.mjs` | Settings schema, sanitization, persistence, defaults, shortcut conflict detection |
| `public/pinshot/settings-view.mjs` | Settings form binding, live preview, section navigation, reset actions, conflict messages |
| `public/pinshot/keyboard.mjs` | Browser-focus shortcut normalization and command mapping |
| `tests/pinshot-state.test.mjs` | State transitions, immutable store behavior, history cap |
| `tests/pinshot-settings.test.mjs` | Setting sanitization, persistence recovery, reset and shortcut conflicts |
| `tests/pinshot-geometry.test.mjs` | Selection math, resize handles, boundary clamping, toolbar placement |
| `tests/pinshot-annotations.test.mjs` | Tool gesture conversion and undo/redo semantics |
| `tests/pinshot-pins.test.mjs` | Pin scale/opacity/lock/collapse/group transforms and history cap |
| `tests/pinshot-keyboard.test.mjs` | Shortcut normalization and command mapping |
| `tests/pinshot-structure.test.mjs` | Required UI regions, labels, settings coverage, local-only asset policy |
| `tests/server-static.test.mjs` | `/pinshot.html`, `.mjs` MIME type, caching and static delivery integration |
| `scripts/check.mjs` | Syntax-check every new PinShot browser module |
| `docs/pinshot-prototype.md` | Local entry, controls, supported prototype behavior, explicit native limitations |

---

### Task 1: Isolated Static Entry and Desktop Shell

**Files:**
- Create: `public/pinshot.html`
- Create: `public/pinshot/styles.css`
- Create: `public/pinshot/app.mjs`
- Modify: `server.js:13-25`
- Modify: `tests/server-static.test.mjs`

**Interfaces:**
- Consumes: existing `serveStatic(req, res, pathname)` and test helpers in `tests/server-static.test.mjs`.
- Produces: public entry `/pinshot.html`, browser-module MIME support for `.mjs`, root element `#pinshotApp`, and UI region IDs used by every later task.

- [ ] **Step 1: Write the failing static-delivery test**

Append this test to `tests/server-static.test.mjs`:

```js
test("PinShot page and browser module are served without admin authentication", async () => {
  await withServer(async (origin) => {
    const page = await request(origin, "/pinshot.html");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html; charset=utf-8$/);
    assert.match(page.body.toString("utf8"), /id="pinshotApp"/);
    assert.match(page.body.toString("utf8"), /这是交互原型，不会读取真实系统屏幕/);

    const module = await request(origin, "/pinshot/app.mjs");
    assert.equal(module.status, 200);
    assert.equal(module.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(module.body.toString("utf8"), /data-pinshot-ready/);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing entry fails**

Run: `node --test tests/server-static.test.mjs --test-name-pattern="PinShot page"`

Expected: FAIL because `/pinshot.html` is `404`.

- [ ] **Step 3: Add `.mjs` static support**

Add `.mjs` to both static maps in `server.js`:

```js
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"]
]);

const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".mjs", ".json", ".svg", ".txt"
]);
```

- [ ] **Step 4: Create the semantic desktop shell**

Create `public/pinshot.html` with these stable regions; later tasks fill their contents without renaming IDs:

```html
<!doctype html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>PinShot 截贴 · PC 截图工具原型</title>
    <link rel="stylesheet" href="/pinshot/styles.css">
  </head>
  <body>
    <main id="pinshotApp" class="pinshot-app" data-mode="idle">
      <section id="desktopScene" class="desktop-scene" aria-label="模拟桌面">
        <div class="desktop-wallpaper" aria-hidden="true"></div>
        <article class="mock-window mock-window--notes" data-window-candidate="notes">
          <header><span>项目备忘</span><span aria-hidden="true">— □ ×</span></header>
          <h1>发布前检查</h1>
          <p>确认首页文案、快捷键与导出流程。</p>
        </article>
        <article class="mock-window mock-window--browser" data-window-candidate="browser">
          <header><span>设计评审</span><span aria-hidden="true">— □ ×</span></header>
          <div class="browser-card"><strong>PinShot</strong><span>更轻、更快的截图与贴图体验</span></div>
        </article>

        <div id="pinLayer" class="pin-layer" aria-label="桌面贴图"></div>
        <div id="captureOverlay" class="capture-overlay" hidden>
          <div id="selectionBox" class="selection-box" hidden></div>
          <canvas id="annotationCanvas" aria-label="截图标注画布"></canvas>
          <output id="selectionSize" class="selection-size" hidden></output>
          <div id="magnifier" class="magnifier" hidden aria-hidden="true"></div>
          <div id="annotationToolbar" class="annotation-toolbar" role="toolbar" aria-label="截图标注工具" hidden></div>
        </div>

        <aside id="historyStrip" class="history-strip" aria-label="最近截图" hidden></aside>
        <dialog id="settingsDialog" class="settings-dialog" aria-labelledby="settingsTitle"></dialog>
        <nav id="trayMenu" class="tray-menu" aria-label="PinShot 托盘菜单" hidden></nav>
      </section>

      <button id="captureLauncher" class="capture-launcher" type="button" title="开始截图 F1">
        <span aria-hidden="true">⌗</span><span>开始截图</span><kbd>F1</kbd>
      </button>
      <button id="trayLauncher" class="tray-launcher" type="button" aria-label="打开 PinShot 托盘菜单" title="打开托盘菜单">P</button>
      <p class="prototype-notice">这是交互原型，不会读取真实系统屏幕、注册全局快捷键或创建原生置顶窗口。</p>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    </main>
    <script type="module" src="/pinshot/app.mjs"></script>
  </body>
</html>
```

- [ ] **Step 5: Add approved base tokens and a ready marker**

Create `public/pinshot/styles.css` with the token and shell baseline:

```css
:root {
  color-scheme: dark;
  --graphite: #171A1F;
  --blue: #4C8DFF;
  --mint: #2FC79A;
  --coral: #F25F5C;
  --surface: #F6F7F9;
  --white: #FFFFFF;
  --text: #20242B;
  --muted: #69707D;
  --desktop-w: 1440;
  --desktop-h: 900;
  font-family: "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif;
  font-size: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 960px; min-height: 100vh; overflow: hidden; background: #0d0f12; }
button, input, select { font: inherit; }
button:focus-visible, input:focus-visible, select:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.pinshot-app { position: relative; width: 100vw; height: 100vh; color: var(--white); overflow: hidden; }
.desktop-scene { position: absolute; inset: 0; overflow: hidden; background: #1c2430; }
.desktop-wallpaper { position: absolute; inset: 0; background: radial-gradient(circle at 72% 18%, #344d69 0, transparent 33%), linear-gradient(145deg, #10151d, #243345); }
.mock-window { position: absolute; overflow: hidden; border: 1px solid rgba(255,255,255,.14); border-radius: 12px; background: rgba(246,247,249,.96); color: var(--text); box-shadow: 0 28px 80px rgba(0,0,0,.28); }
.mock-window header { display: flex; justify-content: space-between; padding: 12px 16px; background: #e9edf2; color: var(--muted); }
.mock-window--notes { left: 7vw; top: 16vh; width: 32vw; min-width: 360px; height: 54vh; padding: 0 28px; }
.mock-window--notes h1 { margin-top: 56px; font-size: 32px; }
.mock-window--browser { right: 6vw; top: 10vh; width: 49vw; height: 66vh; }
.browser-card { display: grid; place-content: center; gap: 12px; height: calc(100% - 44px); text-align: center; background: linear-gradient(135deg,#f5f8ff,#e3fbf3); }
.browser-card strong { font-size: 58px; letter-spacing: -.04em; }
.capture-launcher { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px; border: 1px solid rgba(255,255,255,.2); border-radius: 999px; background: rgba(23,26,31,.9); color: var(--white); }
.capture-launcher kbd { color: #aeb8c6; }
.tray-launcher { position: fixed; right: 22px; bottom: 22px; width: 42px; height: 42px; border: 0; border-radius: 12px; background: var(--blue); color: var(--white); font-weight: 800; }
.prototype-notice { position: fixed; left: 20px; bottom: 18px; margin: 0; max-width: 440px; color: rgba(255,255,255,.68); font-size: 12px; }
.toast { position: fixed; top: 24px; left: 50%; z-index: 100; transform: translate(-50%,-20px); opacity: 0; padding: 10px 14px; border-radius: 9px; background: var(--graphite); box-shadow: 0 16px 40px rgba(0,0,0,.35); transition: .18s ease; }
.toast.is-visible { transform: translate(-50%,0); opacity: 1; }
```

Create `public/pinshot/app.mjs`:

```js
const app = document.querySelector("#pinshotApp");
if (!app) throw new Error("PinShot root is missing");
app.setAttribute("data-pinshot-ready", "true");
```

- [ ] **Step 6: Verify and commit the shell**

Run: `node --test tests/server-static.test.mjs --test-name-pattern="PinShot page"`

Expected: PASS.

Run: `node --check public/pinshot/app.mjs`

Expected: no output and exit code `0`.

Commit:

```bash
git add server.js public/pinshot.html public/pinshot/styles.css public/pinshot/app.mjs tests/server-static.test.mjs
git commit -m "feat: add PinShot prototype shell"
```

---

### Task 2: State Store and Settings Contracts

**Files:**
- Create: `public/pinshot/state.mjs`
- Create: `public/pinshot/settings.mjs`
- Create: `tests/pinshot-state.test.mjs`
- Create: `tests/pinshot-settings.test.mjs`

**Interfaces:**
- Consumes: none; both modules remain DOM-independent.
- Produces: `createInitialState()`, `reducer()`, `createStore()`, `DEFAULT_SETTINGS`, `loadSettings()`, `saveSettings()`, `resetSettings()`, `findShortcutConflict()`.

- [ ] **Step 1: Write failing reducer and store tests**

Create `tests/pinshot-state.test.mjs`:

```js
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
```

- [ ] **Step 2: Write failing settings tests**

Create `tests/pinshot-settings.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, findShortcutConflict, loadSettings, resetSettings, saveSettings } from "../public/pinshot/settings.mjs";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

test("invalid persisted settings fall back to defaults and report recovery", () => {
  const storage = memoryStorage({ "pinshot.settings.v1": "{broken" });
  let notice = "";
  assert.deepEqual(loadSettings(storage, (message) => { notice = message; }), DEFAULT_SETTINGS);
  assert.match(notice, /已恢复默认值/);
});

test("settings round trip retains valid values and clamps pin opacity", () => {
  const storage = memoryStorage();
  saveSettings(storage, { ...DEFAULT_SETTINGS, theme: "light", pinOpacity: 150 });
  const loaded = loadSettings(storage);
  assert.equal(loaded.theme, "light");
  assert.equal(loaded.pinOpacity, 100);
  assert.equal(loaded.mouseActions.closePin, "DoubleClick");
});

test("shortcut conflicts name the existing action", () => {
  assert.equal(findShortcutConflict(DEFAULT_SETTINGS.shortcuts, "paste", "F1"), "capture");
  assert.equal(findShortcutConflict(DEFAULT_SETTINGS.shortcuts, "paste", "Alt+P"), null);
});

test("reset removes persisted overrides", () => {
  const storage = memoryStorage();
  saveSettings(storage, { ...DEFAULT_SETTINGS, theme: "light" });
  assert.deepEqual(resetSettings(storage), DEFAULT_SETTINGS);
});
```

- [ ] **Step 3: Verify both test files fail on missing modules**

Run: `node --test tests/pinshot-state.test.mjs tests/pinshot-settings.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement immutable state transitions**

Create `public/pinshot/state.mjs` with this contract:

```js
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
```

- [ ] **Step 5: Implement approved defaults and safe persistence**

Create `public/pinshot/settings.mjs`:

```js
export const SETTINGS_KEY = "pinshot.settings.v1";
export const DEFAULT_SETTINGS = Object.freeze({
  theme: "dark",
  locale: "zh-CN",
  launchAtStartup: false,
  autoBackup: true,
  quickResponse: true,
  enhancedContextMenu: true,
  logLevel: "normal",
  configLocation: "config.ini",
  showBorder: true,
  showMask: true,
  showHandles: true,
  showMagnifierMask: true,
  showMagnifierBorder: true,
  showMagnifierAnchor: false,
  showCrosshair: false,
  showShortcutHints: true,
  borderWidth: 2,
  maskOpacity: 55,
  annotationColor: "#4C8DFF",
  annotationWidth: 3,
  annotationFontSize: 18,
  pinShadow: true,
  pinOpacity: 100,
  pinMaxSize: 12000,
  thumbnailWidth: 62,
  thumbnailHeight: 62,
  outputFormat: "png",
  outputDirectory: "下载",
  mouseActions: Object.freeze({
    pinScale: "Wheel",
    pinOpacity: "Ctrl+Wheel",
    closePin: "DoubleClick",
    resetPin: "MiddleClick",
    quickThumbnail: "Shift+DoubleClick",
    copyText: "Shift+RightClick"
  }),
  shortcuts: Object.freeze({
    capture: "F1",
    captureAndCopy: "Ctrl+F1",
    customCapture: "Shift+F1",
    paste: "F3",
    togglePins: "Shift+F3",
    cyclePinGroup: "Ctrl+F3"
  })
});

function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value))); }

export function sanitizeSettings(candidate = {}) {
  const shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...(candidate.shortcuts || {}) };
  const mouseActions = { ...DEFAULT_SETTINGS.mouseActions, ...(candidate.mouseActions || {}) };
  return {
    ...DEFAULT_SETTINGS,
    ...candidate,
    theme: candidate.theme === "light" ? "light" : "dark",
    borderWidth: clamp(candidate.borderWidth ?? DEFAULT_SETTINGS.borderWidth, 1, 8),
    maskOpacity: clamp(candidate.maskOpacity ?? DEFAULT_SETTINGS.maskOpacity, 10, 85),
    pinOpacity: clamp(candidate.pinOpacity ?? DEFAULT_SETTINGS.pinOpacity, 10, 100),
    thumbnailWidth: clamp(candidate.thumbnailWidth ?? DEFAULT_SETTINGS.thumbnailWidth, 40, 160),
    thumbnailHeight: clamp(candidate.thumbnailHeight ?? DEFAULT_SETTINGS.thumbnailHeight, 40, 160),
    annotationWidth: clamp(candidate.annotationWidth ?? DEFAULT_SETTINGS.annotationWidth, 1, 16),
    annotationFontSize: clamp(candidate.annotationFontSize ?? DEFAULT_SETTINGS.annotationFontSize, 12, 72),
    mouseActions,
    shortcuts
  };
}

export function loadSettings(storage = window.localStorage, onRecover = () => {}) {
  try { return sanitizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY) || "{}")); }
  catch { onRecover("本地设置已损坏，已恢复默认值"); return structuredClone(DEFAULT_SETTINGS); }
}

export function saveSettings(storage, settings) {
  const sanitized = sanitizeSettings(settings);
  storage.setItem(SETTINGS_KEY, JSON.stringify(sanitized));
  return sanitized;
}

export function resetSettings(storage = window.localStorage) {
  storage.removeItem(SETTINGS_KEY);
  return structuredClone(DEFAULT_SETTINGS);
}

export function findShortcutConflict(shortcuts, action, candidate) {
  const normalized = String(candidate).toLowerCase();
  return Object.entries(shortcuts).find(([name, value]) => name !== action && String(value).toLowerCase() === normalized)?.[0] || null;
}
```

- [ ] **Step 6: Run tests and commit the contracts**

Run: `node --test tests/pinshot-state.test.mjs tests/pinshot-settings.test.mjs`

Expected: `7` tests pass, `0` fail.

Commit:

```bash
git add public/pinshot/state.mjs public/pinshot/settings.mjs tests/pinshot-state.test.mjs tests/pinshot-settings.test.mjs
git commit -m "feat: define PinShot state and settings contracts"
```

---

### Task 3: Capture Geometry and Selection Overlay

**Files:**
- Create: `public/pinshot/geometry.mjs`
- Create: `public/pinshot/capture.mjs`
- Create: `tests/pinshot-geometry.test.mjs`
- Modify: `public/pinshot.html`
- Modify: `public/pinshot/app.mjs`
- Modify: `public/pinshot/styles.css`

**Interfaces:**
- Consumes: store actions `CAPTURE_START`, `CAPTURE_CANCEL`, `SELECTION_SET`; stable shell IDs from Task 1.
- Produces: `normalizeRect()`, `clampRect()`, `resizeRect()`, `findCandidate()`, `placeToolbar()`, and `createCaptureController()`.

- [ ] **Step 1: Write failing geometry tests**

Create `tests/pinshot-geometry.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { clampRect, findCandidate, normalizeRect, placeToolbar, resizeRect } from "../public/pinshot/geometry.mjs";

test("normalizeRect supports dragging in every direction", () => {
  assert.deepEqual(normalizeRect({ x: 300, y: 200 }, { x: 100, y: 80 }), { x: 100, y: 80, width: 200, height: 120 });
});

test("clampRect enforces a 24 pixel minimum inside the desktop", () => {
  assert.deepEqual(clampRect({ x: -10, y: 890, width: 8, height: 30 }, { width: 1440, height: 900 }, 24), { x: 0, y: 876, width: 24, height: 24 });
});

test("resizeRect moves the north-west handle and preserves bounds", () => {
  assert.deepEqual(resizeRect({ x: 100, y: 100, width: 300, height: 200 }, "nw", { x: 60, y: 80 }, { width: 1440, height: 900 }), { x: 60, y: 80, width: 340, height: 220 });
});

test("candidate hit testing chooses the smallest containing window", () => {
  const candidates = [
    { id: "large", x: 0, y: 0, width: 900, height: 700 },
    { id: "small", x: 100, y: 100, width: 400, height: 240 }
  ];
  assert.equal(findCandidate({ x: 180, y: 160 }, candidates).id, "small");
});

test("toolbar flips above when selection is near the bottom", () => {
  assert.deepEqual(placeToolbar({ x: 100, y: 820, width: 600, height: 70 }, { width: 720, height: 48 }, { width: 1440, height: 900 }), { x: 100, y: 760, placement: "above" });
});
```

- [ ] **Step 2: Run the geometry tests and verify module failure**

Run: `node --test tests/pinshot-geometry.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic rectangle math**

Create `public/pinshot/geometry.mjs`:

```js
export function normalizeRect(start, end) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function clampRect(rect, bounds, minimum = 24) {
  const width = Math.min(bounds.width, Math.max(minimum, rect.width));
  const height = Math.min(bounds.height, Math.max(minimum, rect.height));
  return { x: Math.min(bounds.width - width, Math.max(0, rect.x)), y: Math.min(bounds.height - height, Math.max(0, rect.y)), width, height };
}

export function resizeRect(rect, handle, point, bounds) {
  const edges = { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
  if (handle.includes("w")) edges.left = point.x;
  if (handle.includes("e")) edges.right = point.x;
  if (handle.includes("n")) edges.top = point.y;
  if (handle.includes("s")) edges.bottom = point.y;
  return clampRect(normalizeRect({ x: edges.left, y: edges.top }, { x: edges.right, y: edges.bottom }), bounds);
}

export function findCandidate(point, candidates) {
  return candidates
    .filter((candidate) => point.x >= candidate.x && point.x <= candidate.x + candidate.width && point.y >= candidate.y && point.y <= candidate.y + candidate.height)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0] || null;
}

export function placeToolbar(selection, toolbar, bounds, gap = 12) {
  const x = Math.min(bounds.width - toolbar.width, Math.max(0, selection.x));
  if (selection.y + selection.height + gap + toolbar.height <= bounds.height) return { x, y: selection.y + selection.height + gap, placement: "below" };
  if (selection.y - gap - toolbar.height >= 0) return { x, y: selection.y - gap - toolbar.height, placement: "above" };
  return { x, y: Math.max(0, selection.y + selection.height - toolbar.height - gap), placement: "inside" };
}
```

- [ ] **Step 4: Implement the capture controller**

Replace the empty `#selectionBox` in `public/pinshot.html` with eight handles before creating the controller:

```html
<div id="selectionBox" class="selection-box" hidden>
  <span data-handle="nw" aria-hidden="true"></span><span data-handle="n" aria-hidden="true"></span>
  <span data-handle="ne" aria-hidden="true"></span><span data-handle="e" aria-hidden="true"></span>
  <span data-handle="se" aria-hidden="true"></span><span data-handle="s" aria-hidden="true"></span>
  <span data-handle="sw" aria-hidden="true"></span><span data-handle="w" aria-hidden="true"></span>
</div>
```

Create `public/pinshot/capture.mjs` with `createCaptureController({ root, overlay, selectionBox, sizeLabel, magnifier, toolbar, store, getSettings })`. A candidate click with at most 4px pointer movement selects the whole candidate; movement beyond 4px switches to a free selection. Its pointer lifecycle must use this exact flow:

```js
import { clampRect, findCandidate, normalizeRect, placeToolbar, resizeRect } from "./geometry.mjs";

export function createCaptureController(elements, store, getSettings) {
  let drag = null;
  let hoveredCandidate = null;
  let candidates = [];
  const bounds = () => ({ width: elements.root.clientWidth, height: elements.root.clientHeight });
  const point = (event) => ({ x: event.clientX, y: event.clientY });

  function renderRect(rect) {
    Object.assign(elements.selectionBox.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    elements.selectionBox.hidden = false;
    elements.sizeLabel.hidden = false;
    elements.sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }

  function begin(event) {
    if (event.button !== 0) return;
    const handle = event.target.closest?.("[data-handle]")?.dataset.handle;
    drag = handle
      ? { kind: "resize", handle, origin: store.getState().selection }
      : hoveredCandidate
        ? { kind: "candidate", rect: { ...hoveredCandidate }, start: point(event) }
        : { kind: "create", start: point(event) };
    elements.overlay.setPointerCapture?.(event.pointerId);
  }

  function move(event) {
    const cursor = point(event);
    elements.magnifier.hidden = !getSettings().showMagnifierBorder;
    Object.assign(elements.magnifier.style, { left: `${cursor.x + 20}px`, top: `${cursor.y + 20}px` });
    if (!drag) {
      hoveredCandidate = findCandidate(cursor, candidates);
      if (hoveredCandidate) renderRect(hoveredCandidate);
      return;
    }
    if (drag.kind === "candidate") {
      if (Math.hypot(cursor.x - drag.start.x, cursor.y - drag.start.y) <= 4) { renderRect(drag.rect); return; }
      drag = { kind: "create", start: drag.start };
    }
    const rect = drag.kind === "resize" ? resizeRect(drag.origin, drag.handle, cursor, bounds()) : clampRect(normalizeRect(drag.start, cursor), bounds());
    renderRect(rect);
  }

  function end(event) {
    if (!drag) return;
    const cursor = point(event);
    const rect = drag.kind === "candidate" ? drag.rect : drag.kind === "resize" ? resizeRect(drag.origin, drag.handle, cursor, bounds()) : clampRect(normalizeRect(drag.start, cursor), bounds());
    drag = null;
    store.dispatch({ type: "SELECTION_SET", rect });
    renderRect(rect);
    const position = placeToolbar(rect, { width: elements.toolbar.offsetWidth, height: 48 }, bounds());
    Object.assign(elements.toolbar.style, { left: `${position.x}px`, top: `${position.y}px` });
    elements.toolbar.hidden = false;
  }

  return {
    mount(candidateRects) { candidates = candidateRects; elements.overlay.addEventListener("pointerdown", begin); elements.overlay.addEventListener("pointermove", move); elements.overlay.addEventListener("pointerup", end); },
    start() { elements.overlay.hidden = false; store.dispatch({ type: "CAPTURE_START" }); },
    cancel() { elements.overlay.hidden = true; elements.selectionBox.hidden = true; elements.toolbar.hidden = true; store.dispatch({ type: "CAPTURE_CANCEL" }); }
  };
}
```

In `app.mjs`, derive candidate rectangles from `[data-window-candidate]`, create the controller, and connect `#captureLauncher` to `capture.start()`.

- [ ] **Step 5: Style overlay, anchors, magnifier, size label and toolbar placement**

Append these concrete rules to `public/pinshot/styles.css`:

```css
.capture-overlay { position: absolute; inset: 0; z-index: 30; cursor: crosshair; background: rgba(0,0,0,.55); }
.selection-box { position: absolute; z-index: 31; border: 2px solid var(--blue); background: rgba(255,255,255,.03); box-shadow: 0 0 0 9999px rgba(0,0,0,.01); }
.selection-box [data-handle] { position: absolute; width: 10px; height: 10px; border: 2px solid var(--blue); border-radius: 50%; background: var(--white); transform: translate(-50%,-50%); }
.selection-size { position: absolute; z-index: 34; min-height: 24px; padding: 3px 8px; border-radius: 6px; background: var(--graphite); color: var(--white); font-size: 12px; }
.magnifier { position: absolute; z-index: 35; width: 132px; height: 104px; border: 1px solid rgba(255,255,255,.28); border-radius: 8px; background: repeating-conic-gradient(#d8dde5 0 25%,#eef1f5 0 50%) 0/16px 16px; box-shadow: 0 12px 28px rgba(0,0,0,.32); pointer-events: none; }
.magnifier::after { content: ""; position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; border: 1px solid var(--blue); transform: translate(-50%,-50%); }
.annotation-toolbar { position: absolute; z-index: 36; display: flex; align-items: center; min-height: 48px; padding: 6px; border: 1px solid rgba(255,255,255,.12); border-radius: 11px; background: rgba(23,26,31,.94); box-shadow: 0 18px 46px rgba(0,0,0,.36); backdrop-filter: blur(14px); }
```

- [ ] **Step 6: Run tests and commit selection behavior**

Run: `node --test tests/pinshot-geometry.test.mjs`

Expected: `5` tests pass, `0` fail.

Commit:

```bash
git add public/pinshot/geometry.mjs public/pinshot/capture.mjs public/pinshot/app.mjs public/pinshot/styles.css tests/pinshot-geometry.test.mjs
git commit -m "feat: add PinShot capture selection"
```

---

### Task 4: Annotation Model and Canvas Tools

**Files:**
- Create: `public/pinshot/annotations.mjs`
- Create: `public/pinshot/canvas.mjs`
- Create: `tests/pinshot-annotations.test.mjs`
- Modify: `public/pinshot.html`
- Modify: `public/pinshot/app.mjs`
- Modify: `public/pinshot/styles.css`

**Interfaces:**
- Consumes: selected rectangle from the store and `TOOL_SELECT` actions.
- Produces: `createAnnotationHistory()`, `commitAnnotation()`, `undoAnnotation()`, `redoAnnotation()`, `annotationFromGesture()`, and `createCanvasController()`.

- [ ] **Step 1: Write failing annotation-history tests**

Create `tests/pinshot-annotations.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { annotationFromGesture, commitAnnotation, createAnnotationHistory, redoAnnotation, undoAnnotation } from "../public/pinshot/annotations.mjs";

test("rectangle gesture creates a normalized annotation", () => {
  assert.deepEqual(annotationFromGesture("rectangle", { x: 80, y: 60 }, { x: 20, y: 10 }, { color: "#4C8DFF", width: 3 }), { type: "rectangle", x: 20, y: 10, width: 60, height: 50, color: "#4C8DFF", strokeWidth: 3 });
});

test("pen and highlighter gestures preserve point paths", () => {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  assert.equal(annotationFromGesture("pen", points[0], points[1], { points }).points.length, 2);
  assert.equal(annotationFromGesture("highlight", points[0], points[1], { points }).opacity, 0.35);
});

test("undo and redo move complete annotation snapshots", () => {
  let history = createAnnotationHistory();
  history = commitAnnotation(history, { id: "a", type: "rectangle" });
  history = commitAnnotation(history, { id: "b", type: "arrow" });
  history = undoAnnotation(history);
  assert.deepEqual(history.present.map((item) => item.id), ["a"]);
  history = redoAnnotation(history);
  assert.deepEqual(history.present.map((item) => item.id), ["a", "b"]);
});
```

- [ ] **Step 2: Verify the annotation tests fail**

Run: `node --test tests/pinshot-annotations.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement annotation data and undo/redo**

Create `public/pinshot/annotations.mjs`:

```js
import { normalizeRect } from "./geometry.mjs";

export function createAnnotationHistory() { return { past: [], present: [], future: [] }; }
export function commitAnnotation(history, annotation) { return { past: [...history.past, history.present], present: [...history.present, annotation], future: [] }; }
export function undoAnnotation(history) { if (!history.past.length) return history; return { past: history.past.slice(0,-1), present: history.past.at(-1), future: [history.present, ...history.future] }; }
export function redoAnnotation(history) { if (!history.future.length) return history; return { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) }; }

export function annotationFromGesture(tool, start, end, style = {}) {
  const base = { id: style.id || crypto.randomUUID(), color: style.color || "#4C8DFF", strokeWidth: style.width || 3 };
  if (tool === "pen" || tool === "highlight") return { ...base, type: tool, points: style.points || [start,end], opacity: tool === "highlight" ? 0.35 : 1 };
  if (tool === "rectangle" || tool === "mosaic") { const rect = normalizeRect(start,end); return { ...base, type: tool, ...rect }; }
  if (tool === "arrow") return { ...base, type: tool, start, end };
  if (tool === "text") return { ...base, type: tool, x: start.x, y: start.y, text: style.text || "文字", fontSize: style.fontSize || 18 };
  if (tool === "number") return { ...base, type: tool, x: start.x, y: start.y, value: style.value || 1 };
  if (tool === "color") return { ...base, type: tool, x: start.x, y: start.y, value: style.value || "#4C8DFF" };
  throw new Error(`Unsupported annotation tool: ${tool}`);
}
```

- [ ] **Step 4: Implement Canvas 2D rendering and gesture preview**

Create `public/pinshot/canvas.mjs`. Export `renderAnnotations(ctx, annotations)` and `createCanvasController({ canvas, getSelection, getTool, getStyle, onCommit })`. The renderer must use explicit branches:

```js
function line(ctx, points) { ctx.beginPath(); points.forEach((p,i) => i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y)); ctx.stroke(); }

export function renderAnnotations(ctx, annotations) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (const item of annotations) {
    ctx.save(); ctx.strokeStyle = item.color; ctx.fillStyle = item.color; ctx.lineWidth = item.strokeWidth || 3; ctx.globalAlpha = item.opacity ?? 1;
    if (item.type === "rectangle") ctx.strokeRect(item.x,item.y,item.width,item.height);
    if (item.type === "pen" || item.type === "highlight") line(ctx,item.points);
    if (item.type === "arrow") { line(ctx,[item.start,item.end]); const angle=Math.atan2(item.end.y-item.start.y,item.end.x-item.start.x); ctx.beginPath(); ctx.moveTo(item.end.x,item.end.y); ctx.lineTo(item.end.x-14*Math.cos(angle-.45),item.end.y-14*Math.sin(angle-.45)); ctx.lineTo(item.end.x-14*Math.cos(angle+.45),item.end.y-14*Math.sin(angle+.45)); ctx.closePath(); ctx.fill(); }
    if (item.type === "text") { ctx.font = `${item.fontSize}px "Segoe UI Variable","Microsoft YaHei UI",sans-serif`; ctx.fillText(item.text,item.x,item.y); }
    if (item.type === "number") { ctx.beginPath(); ctx.arc(item.x,item.y,13,0,Math.PI*2); ctx.fill(); ctx.fillStyle="#fff"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(String(item.value),item.x,item.y); }
    if (item.type === "mosaic") { ctx.fillStyle="rgba(23,26,31,.6)"; for(let y=item.y;y<item.y+item.height;y+=10) for(let x=item.x;x<item.x+item.width;x+=10) if(((x+y)/10)%2===0) ctx.fillRect(x,y,10,10); }
    if (item.type === "color") { ctx.strokeStyle="#fff"; ctx.strokeRect(item.x-10,item.y-10,20,20); }
    ctx.restore();
  }
}
```

The controller converts screen coordinates to selection-local coordinates, collects paths for pen/highlighter, asks for text through an inline `<input>` overlay rather than `prompt()`, and calls `onCommit(annotationFromGesture(...))` on pointer release.

- [ ] **Step 5: Populate the fixed toolbar and wire undo/redo**

Add buttons in this order to `#annotationToolbar`: `选择、矩形、箭头、画笔、荧光笔、文字、序号、马赛克、取色`, then a separator, then `撤销、重做、复制、保存、贴图、完成`. Each button uses `data-tool` or `data-command`, `title="名称 快捷键"`, and `aria-label="名称"`. In `app.mjs`, route tool buttons to `TOOL_SELECT`, and keep annotation history in the store using explicit `ANNOTATION_COMMIT`, `ANNOTATION_UNDO`, and `ANNOTATION_REDO` reducer cases.

- [ ] **Step 6: Run annotation tests and commit the canvas slice**

Run: `node --test tests/pinshot-annotations.test.mjs`

Expected: `3` tests pass, `0` fail.

Commit:

```bash
git add public/pinshot/annotations.mjs public/pinshot/canvas.mjs public/pinshot.html public/pinshot/app.mjs public/pinshot/styles.css tests/pinshot-annotations.test.mjs
git commit -m "feat: add PinShot annotation canvas"
```

---

### Task 5: Copy, Save and Session-Preserving Output

**Files:**
- Create: `public/pinshot/scene.mjs`
- Create: `public/pinshot/output.mjs`
- Create: `tests/pinshot-output.test.mjs`
- Modify: `public/pinshot/app.mjs`

**Interfaces:**
- Consumes: selected rectangle, rendered annotation canvas, and the simulated viewport dimensions.
- Produces: `drawDesktopScene()`, `buildDownloadName()`, `canvasToBlob()`, `copyCanvas()`, `downloadCanvas()`, `createCompositeCanvas()`.

- [ ] **Step 1: Write failing deterministic output tests**

Create `tests/pinshot-output.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildDownloadName, canvasToBlob } from "../public/pinshot/output.mjs";

test("download names are deterministic PNG names", () => {
  assert.equal(buildDownloadName(new Date("2026-08-01T08:09:07Z")), "PinShot-20260801-080907.png");
});

test("canvasToBlob rejects when the browser returns no blob", async () => {
  const canvas = { toBlob(callback) { callback(null); } };
  await assert.rejects(canvasToBlob(canvas), /无法生成 PNG/);
});
```

- [ ] **Step 2: Run tests and verify module failure**

Run: `node --test tests/pinshot-output.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement a deterministic simulated screenshot source and output functions**

Create `public/pinshot/scene.mjs` so export never depends on an unavailable DOM-to-canvas API:

```js
export function drawDesktopScene(ctx, { width, height, offsetX = 0, offsetY = 0 }) {
  ctx.save();
  ctx.translate(-offsetX, -offsetY);
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#10151D");
  background.addColorStop(1, "#243345");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  const windows = [
    { x: width * .07, y: height * .16, w: Math.max(360, width * .32), h: height * .54, title: "项目备忘" },
    { x: width * .45, y: height * .10, w: width * .49, h: height * .66, title: "设计评审" }
  ];
  for (const item of windows) {
    ctx.fillStyle = "#F6F7F9"; ctx.fillRect(item.x, item.y, item.w, item.h);
    ctx.fillStyle = "#E9EDF2"; ctx.fillRect(item.x, item.y, item.w, 44);
    ctx.fillStyle = "#69707D"; ctx.font = '14px "Segoe UI Variable","Microsoft YaHei UI",sans-serif'; ctx.fillText(item.title, item.x + 16, item.y + 27);
  }
  ctx.fillStyle = "#20242B"; ctx.font = '700 32px "Segoe UI Variable","Microsoft YaHei UI",sans-serif'; ctx.fillText("发布前检查", windows[0].x + 28, windows[0].y + 120);
  ctx.fillStyle = "#4C8DFF"; ctx.font = '800 58px "Segoe UI Variable",sans-serif'; ctx.fillText("PinShot", windows[1].x + windows[1].w * .31, windows[1].y + windows[1].h * .5);
  ctx.restore();
}
```

Create `public/pinshot/output.mjs`:

```js
import { drawDesktopScene } from "./scene.mjs";

export function buildDownloadName(date = new Date()) {
  const digits = (value) => String(value).padStart(2,"0");
  return `PinShot-${date.getUTCFullYear()}${digits(date.getUTCMonth()+1)}${digits(date.getUTCDate())}-${digits(date.getUTCHours())}${digits(date.getUTCMinutes())}${digits(date.getUTCSeconds())}.png`;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve,reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法生成 PNG")), "image/png"));
}

export async function copyCanvas(canvas, clipboard = navigator.clipboard) {
  const blob = await canvasToBlob(canvas);
  if (!clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("浏览器未开放图片剪贴板权限，请使用保存");
  await clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return blob;
}

export async function downloadCanvas(canvas, documentRef = document) {
  const blob = await canvasToBlob(canvas);
  const link = documentRef.createElement("a");
  link.download = buildDownloadName(); link.href = URL.createObjectURL(blob); link.click(); URL.revokeObjectURL(link.href);
  return blob;
}

export function createCompositeCanvas(annotationCanvas, selection, viewport, documentRef = document, drawScene = drawDesktopScene) {
  const canvas = documentRef.createElement("canvas"); canvas.width = Math.round(selection.width); canvas.height = Math.round(selection.height);
  const ctx = canvas.getContext("2d");
  drawScene(ctx, { ...viewport, offsetX: selection.x, offsetY: selection.y });
  ctx.drawImage(annotationCanvas, 0, 0, selection.width, selection.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
```

- [ ] **Step 4: Route copy, save and complete without losing failed sessions**

In `app.mjs`, implement `runOutput(command)` so it creates one composite canvas, only dispatches `CAPTURE_CANCEL` after copy/save succeeds, dispatches `HISTORY_ADD` after success, and on error keeps `mode`, `selection`, and annotations unchanged while showing the error toast. `Enter` maps to copy; the toolbar maps `copy`, `save`, and `complete` to the same function.

- [ ] **Step 5: Run output tests and commit**

Run: `node --test tests/pinshot-output.test.mjs`

Expected: `2` tests pass, `0` fail.

Commit:

```bash
git add public/pinshot/scene.mjs public/pinshot/output.mjs public/pinshot/app.mjs tests/pinshot-output.test.mjs
git commit -m "feat: add PinShot copy and save actions"
```

---

### Task 6: Desktop Pins and Eight-Item Recent History

**Files:**
- Create: `public/pinshot/pins.mjs`
- Create: `tests/pinshot-pins.test.mjs`
- Modify: `public/pinshot.html`
- Modify: `public/pinshot/app.mjs`
- Modify: `public/pinshot/styles.css`

**Interfaces:**
- Consumes: composite PNG/object URL and reducer actions `PIN_CREATE`, `PIN_UPDATE`, `PIN_REMOVE`, `HISTORY_ADD`.
- Produces: `createPin()`, `scalePin()`, `changePinOpacity()`, `togglePinLock()`, `togglePinCollapse()`, `toggleGroupVisibility()`, `renderPins()`.

- [ ] **Step 1: Write failing pin-state tests**

Create `tests/pinshot-pins.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { changePinOpacity, createPin, scalePin, togglePinCollapse, togglePinLock } from "../public/pinshot/pins.mjs";

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
```

- [ ] **Step 2: Verify tests fail on missing module**

Run: `node --test tests/pinshot-pins.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure pin transforms**

Create `public/pinshot/pins.mjs` with these exports:

```js
const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
export function createPin(input) { return { x: 80, y: 80, width: 320, height: 180, scale: 1, opacity: 100, locked: false, collapsed: false, hidden: false, group: "default", rotation: 0, ...input }; }
export function scalePin(pin, direction) { return { ...pin, scale: clamp(Number((pin.scale + direction * .1).toFixed(1)), .2, 4) }; }
export function changePinOpacity(pin, direction) { return { ...pin, opacity: clamp(pin.opacity + direction * 5, 10, 100) }; }
export function togglePinLock(pin) { return { ...pin, locked: !pin.locked }; }
export function togglePinCollapse(pin) { return { ...pin, collapsed: !pin.collapsed }; }
export function rotatePin(pin) { return { ...pin, rotation: (pin.rotation + 90) % 360 }; }
export function toggleGroupVisibility(pins, group = "default") { const visible = pins.some((pin) => pin.group === group && !pin.hidden); return pins.map((pin) => pin.group === group ? { ...pin, hidden: visible } : pin); }
```

- [ ] **Step 4: Render movable pin cards and recent thumbnails**

In `renderPins(container, pins, dispatch, settings)`, create one `.pin-card` per non-hidden pin with an `<img alt="贴图 N">`, a hover toolbar containing `锁定、旋转、复制、保存、关闭`, and `data-pin-id`. Pointer drag updates `x/y` unless locked. Route wheel, `Ctrl + wheel`, double-click, middle-click, `Shift + double-click`, and `Shift + right-click` through `settings.mouseActions`; the approved defaults call `scalePin`, `changePinOpacity`, remove the pin, reset scale/opacity/rotation, toggle collapse, and copy recognized text feedback respectively. Render `#historyStrip` from `state.history.slice(0,8)` and dispatch `HISTORY_RESTORE` on thumbnail activation.

Append CSS for `.pin-card`, `.pin-card__toolbar`, `.pin-card.is-locked`, `.pin-card.is-collapsed`, and `.history-strip`. The card must be borderless, use `box-shadow: 0 16px 42px rgba(0,0,0,.34)`, and show mint state text when locked or successfully pinned.

- [ ] **Step 5: Wire `F3`, group visibility and history restore**

In `app.mjs`, map toolbar `paste` and `F3` to `PIN_CREATE`; map `Shift+F3` to a reducer action that toggles the default group; map `Ctrl+F3` to cycle between `default`, `reference`, and `temporary`; map history restore to reopen the composite in selected mode.

- [ ] **Step 6: Run tests and commit pins/history**

Run: `node --test tests/pinshot-pins.test.mjs tests/pinshot-state.test.mjs`

Expected: all tests pass, including the eight-item history cap.

Commit:

```bash
git add public/pinshot/pins.mjs public/pinshot.html public/pinshot/app.mjs public/pinshot/styles.css tests/pinshot-pins.test.mjs tests/pinshot-state.test.mjs
git commit -m "feat: add PinShot desktop pins and history"
```

---

### Task 7: Complete Settings Center and Theme Preview

**Files:**
- Create: `public/pinshot/settings-view.mjs`
- Create: `tests/pinshot-structure.test.mjs`
- Modify: `public/pinshot.html`
- Modify: `public/pinshot/app.mjs`
- Modify: `public/pinshot/styles.css`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS`, `loadSettings()`, `saveSettings()`, `resetSettings()`, `findShortcutConflict()`.
- Produces: `createSettingsView({ dialog, settings, onChange, onReset, onClose })` and a complete settings DOM with six approved sections.

- [ ] **Step 1: Write failing structure and local-only policy tests**

Create `tests/pinshot-structure.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PinShot exposes all approved settings sections and core controls", async () => {
  const html = await readFile("public/pinshot.html", "utf8");
  for (const section of ["通用","截图","标注","贴图","快捷键","输出"]) assert.match(html, new RegExp(`>${section}<`));
  for (const setting of ["launchAtStartup","autoBackup","quickResponse","showBorder","showMask","showHandles","annotationColor","pinShadow","pinOpacity","mouseActions.pinScale","mouseActions.closePin","shortcuts.capture","shortcuts.paste","outputFormat"]) assert.match(html, new RegExp(`data-setting="${setting.replaceAll(".","\\.")}"`));
  assert.match(html, /aria-labelledby="settingsTitle"/);
});

test("PinShot remains local-only and loads no remote assets", async () => {
  const files = ["public/pinshot.html","public/pinshot/app.mjs","public/pinshot/settings-view.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(file,"utf8")))).join("\n");
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

test("every icon-only button has an accessible Chinese label", async () => {
  const html = await readFile("public/pinshot.html", "utf8");
  const iconButtons = [...html.matchAll(/<button[^>]*data-icon-only[^>]*>/g)].map((match) => match[0]);
  assert.ok(iconButtons.length >= 8);
  for (const button of iconButtons) assert.match(button, /aria-label="[^\"]*[\u4e00-\u9fff][^\"]*"/);
});
```

- [ ] **Step 2: Run tests and verify missing settings markup fails**

Run: `node --test tests/pinshot-structure.test.mjs`

Expected: FAIL because settings sections and controls are absent.

- [ ] **Step 3: Add the six-section settings markup**

Populate `#settingsDialog` with a header (`#settingsTitle`, close button), 176px navigation, and six panels. Use these exact control bindings:

```html
<nav class="settings-nav" aria-label="设置分类">
  <button type="button" data-settings-section="general" aria-current="page">通用</button>
  <button type="button" data-settings-section="capture">截图</button>
  <button type="button" data-settings-section="annotation">标注</button>
  <button type="button" data-settings-section="pin">贴图</button>
  <button type="button" data-settings-section="shortcuts">快捷键</button>
  <button type="button" data-settings-section="output">输出</button>
</nav>
```

The general panel binds `theme`, `locale`, `launchAtStartup`, `autoBackup`, `quickResponse`, `enhancedContextMenu`, `logLevel`, and a read-only `configLocation`; capture binds `showBorder`, `showMask`, `showHandles`, `showMagnifierMask`, `showMagnifierBorder`, `showMagnifierAnchor`, `showCrosshair`, `showShortcutHints`, `borderWidth`, `maskOpacity`; annotation binds `annotationColor`, `annotationWidth`, and `annotationFontSize`; pin binds `pinShadow`, `pinOpacity`, `pinMaxSize`, `thumbnailWidth`, `thumbnailHeight` and the six `mouseActions.*` mappings; shortcuts binds the six `shortcuts.*` actions; output binds `outputFormat` and `outputDirectory`. Startup, backup, logging, and config-location controls are visibly labeled as simulated preferences in the browser prototype. Every panel contains a live `.settings-preview` and a “恢复本组默认” button; the dialog footer contains “恢复全部默认”.

- [ ] **Step 4: Implement settings view binding and conflict feedback**

Create `public/pinshot/settings-view.mjs`. `createSettingsView()` must:

```js
import { DEFAULT_SETTINGS, findShortcutConflict } from "./settings.mjs";

export function createSettingsView({ dialog, settings, onChange, onReset, onClose }) {
  let current = structuredClone(settings);
  function setValue(path, value) {
    if (path.startsWith("shortcuts.")) {
      const action = path.split(".")[1];
      const conflict = findShortcutConflict(current.shortcuts, action, value);
      const message = dialog.querySelector(`[data-conflict-for="${action}"]`);
      message.textContent = conflict ? `与 ${conflict} 冲突，已保留原快捷键` : "";
      if (conflict) return;
      current.shortcuts = { ...current.shortcuts, [action]: value };
    } else if (path.startsWith("mouseActions.")) {
      const action = path.split(".")[1];
      current.mouseActions = { ...current.mouseActions, [action]: value };
    } else current[path] = value;
    onChange(structuredClone(current));
  }
  dialog.addEventListener("change", (event) => {
    const field = event.target.closest("[data-setting]"); if (!field) return;
    setValue(field.dataset.setting, field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value);
  });
  dialog.querySelector("[data-settings-close]").addEventListener("click", onClose);
  dialog.querySelector("[data-reset-all]").addEventListener("click", () => { current = structuredClone(DEFAULT_SETTINGS); onReset(current); });
  return { open() { dialog.showModal(); }, close() { dialog.close(); }, getSettings: () => structuredClone(current) };
}
```

Shortcut inputs enter recording mode on click, normalize the next `keydown`, and call `setValue("shortcuts.action", normalized)`. Section navigation sets `aria-current`, toggles exactly one panel, and moves focus to its heading.

- [ ] **Step 5: Apply live themes, previews, responsive layout and reduced motion**

Append CSS so `.settings-dialog` is 860 × 620px, `.settings-nav` is 176px, panels scroll independently, and previews update through CSS custom properties. Add:

```css
html[data-theme="light"] { color-scheme: light; }
.settings-dialog { width: min(860px,calc(100vw - 48px)); height: min(620px,calc(100vh - 48px)); padding: 0; border: 1px solid rgba(255,255,255,.15); border-radius: 14px; background: var(--surface); color: var(--text); box-shadow: 0 30px 90px rgba(0,0,0,.38); }
.settings-layout { display: grid; grid-template-columns: 176px minmax(0,1fr); height: calc(100% - 112px); }
.settings-nav { padding: 14px; border-right: 1px solid #dfe3e8; background: #edf0f4; }
.settings-nav button { display: block; width: 100%; min-height: 40px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); text-align: left; }
.settings-nav button[aria-current="page"] { background: var(--white); color: var(--text); box-shadow: 0 4px 14px rgba(32,36,43,.08); }
.settings-panel { padding: 20px 24px 28px; overflow: auto; }
@media (max-width: 1100px), (max-height: 760px) { .settings-dialog { width: calc(100vw - 28px); height: calc(100vh - 28px); } .prototype-notice { display: none; } }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
```

In `app.mjs`, call `loadSettings(window.localStorage, showToast)` before creating the store, apply `document.documentElement.dataset.theme`, save on every valid change, and update overlay opacity, border width, pin shadow, and pin opacity immediately. The recovery callback produces exactly one non-blocking notification when persisted JSON is invalid.

- [ ] **Step 6: Run settings and structure tests, then commit**

Run: `node --test tests/pinshot-settings.test.mjs tests/pinshot-structure.test.mjs`

Expected: all tests pass.

Commit:

```bash
git add public/pinshot.html public/pinshot/app.mjs public/pinshot/styles.css public/pinshot/settings-view.mjs tests/pinshot-structure.test.mjs
git commit -m "feat: complete PinShot settings center"
```

---

### Task 8: Keyboard Routing, Accessibility and Integrated State Rendering

**Files:**
- Create: `public/pinshot/keyboard.mjs`
- Create: `tests/pinshot-keyboard.test.mjs`
- Modify: `public/pinshot/app.mjs`
- Modify: `public/pinshot/state.mjs`
- Modify: `public/pinshot.html`
- Modify: `public/pinshot/styles.css`

**Interfaces:**
- Consumes: settings shortcut map and command functions from Tasks 3–7.
- Produces: `normalizeShortcut(event)`, `commandForShortcut(event, settings, mode)`, complete mode renderer, focus restoration and Escape layering.

- [ ] **Step 1: Write failing keyboard-routing tests**

Create `tests/pinshot-keyboard.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { commandForShortcut, normalizeShortcut } from "../public/pinshot/keyboard.mjs";
import { DEFAULT_SETTINGS } from "../public/pinshot/settings.mjs";

const key = (key, overrides = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides });

test("shortcut normalization uses stable modifier order", () => {
  assert.equal(normalizeShortcut(key("F1", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+F1");
});

test("default shortcuts map to approved commands", () => {
  assert.equal(commandForShortcut(key("F1"), DEFAULT_SETTINGS, "idle"), "capture");
  assert.equal(commandForShortcut(key("F3"), DEFAULT_SETTINGS, "selected"), "paste");
  assert.equal(commandForShortcut(key("Enter"), DEFAULT_SETTINGS, "selected"), "copy");
  assert.equal(commandForShortcut(key("Escape"), DEFAULT_SETTINGS, "annotating"), "escape");
  assert.equal(commandForShortcut(key("z", { ctrlKey: true }), DEFAULT_SETTINGS, "annotating"), "undo");
});

test("typing in a form field suppresses capture shortcuts", () => {
  assert.equal(commandForShortcut({ ...key("F1"), target: { matches: () => true } }, DEFAULT_SETTINGS, "idle"), null);
});
```

- [ ] **Step 2: Verify keyboard tests fail**

Run: `node --test tests/pinshot-keyboard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement normalized shortcut routing**

Create `public/pinshot/keyboard.mjs`:

```js
export function normalizeShortcut(event) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!["Control","Alt","Shift","Meta"].includes(key)) parts.push(key);
  return parts.join("+");
}

export function commandForShortcut(event, settings, mode) {
  if (event.target?.matches?.("input,textarea,select,[contenteditable='true']")) return null;
  const value = normalizeShortcut(event);
  const configured = Object.entries(settings.shortcuts).find(([,shortcut]) => shortcut === value)?.[0];
  if (configured) return configured;
  if (value === "Enter" && ["selected","annotating"].includes(mode)) return "copy";
  if (value === "Escape") return "escape";
  if (value === "Ctrl+Z" && mode === "annotating") return "undo";
  if (value === "Ctrl+Shift+Z" && mode === "annotating") return "redo";
  return null;
}
```

- [ ] **Step 4: Centralize command execution and layered Escape behavior**

In `app.mjs`, create one `execute(command)` switch. `escape` closes in this exact priority: inline text editor → tray menu → settings dialog → active annotation tool → capture session. Prevent default only for commands that PinShot handles. After closing settings, restore focus to the tray launcher; after completing capture, restore focus to the capture launcher.

The store subscription must update `#pinshotApp[data-mode]`, `hidden` states, selected toolbar button `aria-pressed`, settings dialog visibility, pin layer, history strip, and toast. Do not mutate DOM outside this renderer except pointer-position styles required during dragging.

- [ ] **Step 5: Add final accessibility and focus styling**

Ensure every toolbar button has `aria-pressed`, separators use `role="separator"`, tooltips are visible after 400ms hover/focus, pin cards expose position-independent names, settings errors use `role="status"`, and the dialog has a logical tab order. Add `.sr-only`, `[aria-pressed="true"]`, `[data-tooltip]::after`, and high-contrast `:focus-visible` rules.

- [ ] **Step 6: Run keyboard tests and commit integrated routing**

Run: `node --test tests/pinshot-keyboard.test.mjs tests/pinshot-state.test.mjs tests/pinshot-structure.test.mjs`

Expected: all tests pass.

Commit:

```bash
git add public/pinshot/keyboard.mjs public/pinshot/app.mjs public/pinshot/state.mjs public/pinshot.html public/pinshot/styles.css tests/pinshot-keyboard.test.mjs
git commit -m "feat: integrate PinShot keyboard and accessibility"
```

---

### Task 9: Repository Checks, Documentation and Browser Acceptance

**Files:**
- Create: `docs/pinshot-prototype.md`
- Modify: `scripts/check.mjs`
- Modify: `README.md`
- Modify: `tests/server-static.test.mjs`

**Interfaces:**
- Consumes: every PinShot module and UI route from Tasks 1–8.
- Produces: syntax coverage in `npm.cmd run check`, discoverable local instructions, full static integration assertions, and verified screenshots at three PC viewport sizes.

- [ ] **Step 1: Extend syntax and static integration coverage**

Add every PinShot module to `scripts/check.mjs`:

```js
const pinshotFiles = [
  "public/pinshot/app.mjs",
  "public/pinshot/state.mjs",
  "public/pinshot/geometry.mjs",
  "public/pinshot/capture.mjs",
  "public/pinshot/annotations.mjs",
  "public/pinshot/canvas.mjs",
  "public/pinshot/scene.mjs",
  "public/pinshot/output.mjs",
  "public/pinshot/pins.mjs",
  "public/pinshot/settings.mjs",
  "public/pinshot/settings-view.mjs",
  "public/pinshot/keyboard.mjs"
];
files.push(...pinshotFiles);
```

Extend the PinShot test in `tests/server-static.test.mjs` to request `/pinshot/styles.css`, verify `text/css; charset=utf-8`, verify non-empty ETags for HTML/CSS/MJS, and verify `HEAD /pinshot/app.mjs` returns no body.

- [ ] **Step 2: Document the local artifact and limitations**

Create `docs/pinshot-prototype.md` with:

```markdown
# PinShot 截贴交互原型

启动仓库服务后访问 `http://localhost:3000/pinshot.html`。如果 3000 被占用，请使用终端输出的实际端口。

## 可演示能力

- `F1` 或“开始截图”：进入模拟截图蒙层。
- 拖拽或悬停窗口：建立选区，并调整八个锚点。
- 标注栏：矩形、箭头、画笔、荧光笔、文字、序号、马赛克、取色、撤销和重做。
- `Enter`：复制；工具栏可保存 PNG 或生成桌面贴图。
- 贴图：移动、滚轮缩放、`Ctrl + 滚轮` 调透明度、锁定、旋转、收起和关闭。
- 设置：通用、截图、标注、贴图、快捷键、输出；修改自动保存在浏览器本地。

## 原型边界

此版本只验证 PC 截图工具的视觉和交互，不读取真实系统屏幕、不注册系统级全局快捷键，也不创建原生始终置顶窗口。所有演示数据和设置留在当前浏览器中，不会上传。
```

Add a short “PinShot 原型” section to `README.md` linking to `/pinshot.html` and `docs/pinshot-prototype.md`; do not alter existing HTMLWorkbench deployment instructions.

- [ ] **Step 3: Run focused tests before the full suite**

Run:

```powershell
node --test tests/pinshot-state.test.mjs tests/pinshot-settings.test.mjs tests/pinshot-geometry.test.mjs tests/pinshot-annotations.test.mjs tests/pinshot-output.test.mjs tests/pinshot-pins.test.mjs tests/pinshot-keyboard.test.mjs tests/pinshot-structure.test.mjs
```

Expected: all focused tests pass, `0` fail.

- [ ] **Step 4: Run the complete repository gate**

Run: `npm.cmd run check`

Expected: all syntax checks and all repository tests pass, including the pre-existing HTMLWorkbench suite.

- [ ] **Step 5: Perform browser acceptance at three PC sizes**

Start the existing service in a retained terminal:

```powershell
npm.cmd run dev
```

Open the exact reported URL with `/pinshot.html`. Verify the following at `1366 × 768`, `1440 × 900`, and `1920 × 1080`:

1. `F1 → drag selection → Enter` produces copy feedback and returns to the desktop; if clipboard permission is denied, the session remains visible and “保存” works.
2. All eight resize handles remain reachable at every screen edge; the size label, magnifier and 48px toolbar remain inside the viewport.
3. Each annotation tool creates a visible result; undo and redo restore exact object order.
4. `F3` creates a pin; drag, wheel, `Ctrl + wheel`, lock, rotate, collapse and close work.
5. The ninth captured item evicts the oldest history item; eight thumbnails remain.
6. Settings cover all six sections, persist after reload, detect shortcut conflicts and restore defaults.
7. Keyboard focus is visible, icon buttons have Chinese names, and reduced-motion mode removes nonessential transitions.
8. The result looks like a desktop capture utility rather than a web dashboard.

Capture one screenshot per viewport under `qa-screenshots/` named `pinshot-1366x768.png`, `pinshot-1440x900.png`, and `pinshot-1920x1080.png`. Inspect each image before accepting the layout.

- [ ] **Step 6: Review the final diff and commit documentation/verification wiring**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only PinShot files, the `.mjs` static support, tests, `scripts/check.mjs`, and the two documentation files are changed.

Commit:

```bash
git add scripts/check.mjs tests/server-static.test.mjs docs/pinshot-prototype.md README.md qa-screenshots/pinshot-1366x768.png qa-screenshots/pinshot-1440x900.png qa-screenshots/pinshot-1920x1080.png
git commit -m "test: verify PinShot interactive prototype"
```

---

## Final Completion Audit

- [ ] Map each approved design requirement to a passing test or browser-acceptance item.
- [ ] Confirm `/pinshot.html` and every local module/style request returns `200` with the correct MIME type.
- [ ] Confirm the existing root page, login flow, upload APIs, and existing tests remain unchanged and passing.
- [ ] Confirm there are no remote requests in PinShot source and no uploaded screenshot data.
- [ ] Confirm all six settings sections cover every capability mapped from the five Snipaste reference images.
- [ ] Confirm the three screenshots show valid PC layouts with no clipped toolbar, selection handles, settings content, pins or history strip.
- [ ] Confirm the prototype limitation notice is visible and the documentation does not imply native capture support.
- [ ] Confirm `git status --short --branch` is clean after the final commit.
