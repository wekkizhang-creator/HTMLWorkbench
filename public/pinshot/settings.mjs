export const SETTINGS_KEY = "pinshot.settings.v1";
export const PIN_MAX_SIZE_MIN = 320;
export const PIN_MAX_SIZE_MAX = 12000;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}
function clampFinite(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}


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
    pinMaxSize: clampFinite(candidate.pinMaxSize ?? DEFAULT_SETTINGS.pinMaxSize, PIN_MAX_SIZE_MIN, PIN_MAX_SIZE_MAX, DEFAULT_SETTINGS.pinMaxSize),
    thumbnailHeight: clamp(candidate.thumbnailHeight ?? DEFAULT_SETTINGS.thumbnailHeight, 40, 160),
    annotationWidth: clamp(candidate.annotationWidth ?? DEFAULT_SETTINGS.annotationWidth, 1, 16),
    annotationFontSize: clamp(candidate.annotationFontSize ?? DEFAULT_SETTINGS.annotationFontSize, 12, 72),
    mouseActions,
    shortcuts
  };
}

export function loadSettings(storage = window.localStorage, onRecover = () => {}) {
  try {
    return sanitizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY) || "{}"));
  } catch {
    onRecover("本地设置已损坏，已恢复默认值");
    return structuredClone(DEFAULT_SETTINGS);
  }
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
