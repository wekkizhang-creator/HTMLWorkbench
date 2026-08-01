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

test("hidden PinShot layers override component display declarations", async () => {
  const css = await readFile("public/pinshot/styles.css", "utf8");
  const html = await readFile("public/pinshot.html", "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(css, /\.annotation-toolbar\s*\{[^}]*display:\s*flex;/);
  assert.match(html, /<link rel="stylesheet" href="\/pinshot\/styles\.css\?v=20260802">/);
  assert.match(css, /\.magnifier\s*\{[^}]*display:\s*var\(/);
});

test("tray menu has a fixed, clickable popover layer beside the launcher", async () => {
  const css = await readFile("public/pinshot/styles.css", "utf8");
  const html = await readFile("public/pinshot.html", "utf8");
  assert.match(html, /id="trayMenu" class="tray-menu"/);
  assert.match(css, /\.tray-menu\s*\{[^}]*position:\s*fixed;[^}]*right:\s*22px;[^}]*bottom:\s*74px;[^}]*z-index:\s*50;[^}]*background:/);
  assert.match(css, /\.tray-menu button\s*\{[^}]*cursor:\s*pointer;/);
});

test("settings dialog assigns vertical overflow only to its active panel", async () => {
  const css = await readFile("public/pinshot/styles.css", "utf8");
  assert.match(css, /\.settings-dialog\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto;[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.settings-layout\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;/);
  assert.match(css, /\.settings-nav\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.settings-panel\s*\{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/);
});

test("closed settings dialog remains hidden despite its grid display", async () => {
  const css = await readFile("public/pinshot/styles.css", "utf8");
  assert.match(css, /\.settings-dialog:not\(\[open\]\)\s*\{\s*display:\s*none;\s*\}/);
});
