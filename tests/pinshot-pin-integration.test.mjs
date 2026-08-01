import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("application wires F3 pin creation and the two pin-group shortcuts", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(source, /createPinFromSelection/);
  assert.match(source, /createKeyboardRouter/);
  assert.match(source, /PIN_GROUP_TOGGLE/);
  assert.match(source, /PIN_GROUP_CYCLE/);
});

test("pin controls retain the required borderless, accessible desktop treatment", async () => {
  const [html, css] = await Promise.all([
    readFile("public/pinshot.html", "utf8"),
    readFile("public/pinshot/styles.css", "utf8")
  ]);
  assert.match(html, /id="pinLayer"/);
  assert.match(html, /id="historyStrip"/);
  assert.match(css, /\.pin-card \{[^}]*border:\s*0;[^}]*box-shadow:\s*0 16px 42px rgba\(0,0,0,\.34\);/s);
  assert.match(css, /\.pin-card__toolbar button \{[^}]*min-width:\s*36px;[^}]*min-height:\s*36px;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.pin-card__toolbar \{ transition: none; \}[\s\S]*?\}/);
  assert.match(css, /\.pin-card\.is-locked[^}]*#2FC79A/s);
});
test("pin rendering is not repeated for every annotation tool button", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.doesNotMatch(source, /for \(const button of toolbar\.querySelectorAll\("\[data-tool\]"\)\) \{\s*renderPins/s);
});
test("application injects browser clipboard and download dependencies into pin rendering", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(source, /createPinActions/);
  assert.match(source, /clipboard:\s*navigator\.clipboard/);
  assert.match(source, /actions:\s*pinActions/);
});
