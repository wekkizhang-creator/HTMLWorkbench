import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PinShot exposes all approved settings sections and core controls", async () => {
  const html = await readFile("public/pinshot.html", "utf8");
  for (const section of ["通用", "截图", "标注", "贴图", "快捷键", "输出"]) assert.match(html, new RegExp(`>${section}<`));
  for (const setting of ["launchAtStartup", "autoBackup", "quickResponse", "showBorder", "showMask", "showHandles", "annotationColor", "pinShadow", "pinOpacity", "mouseActions.pinScale", "mouseActions.closePin", "shortcuts.capture", "shortcuts.paste", "outputFormat"]) assert.match(html, new RegExp(`data-setting="${setting.replaceAll(".", "\\.")}"`));
  assert.match(html, /aria-labelledby="settingsTitle"/);
});

test("PinShot remains local-only and loads no remote assets", async () => {
  const files = ["public/pinshot.html", "public/pinshot/app.mjs", "public/pinshot/settings-view.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});

test("every icon-only button has an accessible Chinese label", async () => {
  const html = await readFile("public/pinshot.html", "utf8");
  const iconButtons = [...html.matchAll(/<button[^>]*data-icon-only[^>]*>/g)].map((match) => match[0]);
  assert.ok(iconButtons.length >= 8);
  for (const button of iconButtons) assert.match(button, /aria-label="[^\"]*[\u4e00-\u9fff][^\"]*"/);
});
