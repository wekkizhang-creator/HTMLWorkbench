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


test("F3 accepts an active selection, restored history, or the latest idle history item", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(source, /resolvePinSource/);
  assert.match(
    source,
    /if \(command === "paste"\) \{\s*const pinSource = resolvePinSource\(state\);\s*if \(!pinSource\) return false;\s*void createPinFromSelection\(pinSource\);\s*return true;/s
  );
});

test("application fits each new pin inside the current pin layer before creation", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(source, /dispatchFittedPin/);
  assert.match(source, /width:\s*pinLayer\.clientWidth/);
  assert.match(source, /height:\s*pinLayer\.clientHeight/);
  assert.match(source, /activeSettings\.pinMaxSize/);
});

test("application pin creation rejects unsafe geometry without dispatching PIN_CREATE", async () => {
  const pinCreation = await import("../public/pinshot/pin-creation.mjs").catch(() => ({}));
  assert.equal(typeof pinCreation.dispatchFittedPin, "function");
  const actions = [];
  assert.throws(
    () => pinCreation.dispatchFittedPin({
      dispatch: (action) => actions.push(action),
      pin: { width: 320, height: 180 },
      viewport: { width: 0, height: 600 },
      maxSize: 12000
    }),
    /无法在当前视口创建贴图/
  );
  assert.deepEqual(actions, []);
});

test("history restore reopens the capture overlay and recalculates its toolbar from the viewport", async () => {
  const source = await readFile("public/pinshot/app.mjs", "utf8");
  assert.match(source, /captureOverlay\.hidden = !captureView\.active/);
  assert.match(source, /action\.type === "HISTORY_RESTORE" && state\.selection/);
  assert.match(source, /getToolbarPosition\(state\.selection, toolbar, \{ width: desktopScene\.clientWidth, height: desktopScene\.clientHeight \}\)/);
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
test("pin rendering compensates quarter-turns and names cards for assistive technology", async () => {
  const [source, css] = await Promise.all([
    readFile("public/pinshot/pins.mjs", "utf8"),
    readFile("public/pinshot/styles.css", "utf8")
  ]);
  assert.match(source, /getPinDisplayGeometry/);
  assert.match(source, /card\.setAttribute\("aria-label"/);
  assert.match(css, /\.pin-card \{[^}]*transform:\s*translate\(var\(--pin-translate-x/s);
  assert.match(css, /transform-origin:\s*top left;/);
});
