import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const asset = (name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

async function helpers() {
  const source = await asset("editor.js");
  const context = vm.createContext({ TextEncoder, URL, console });
  vm.runInContext(source.replace(/^import[\s\S]*?from "\.\/editor-[\w-]+\.mjs";\s*/gm, "")
    .replace(/initializeEditor\(\);\s*$/, ""), context);
  return context;
}

test("editor page exposes the approved workbench and safe sandbox", async () => {
  const html = await asset("editor.html");
  for (const id of ["moduleTree", "editorCanvas", "styleInspector", "saveButton", "undoButton", "redoButton", "previewButton", "deleteButton", "breadcrumbs", "loadState", "retryButton"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /sandbox="allow-same-origin"/);
  assert.doesNotMatch(html, /allow-scripts/);
  assert.match(html, /src="\/brand-logo.png"/);
  assert.match(html, /type="module" src="\/editor.js"/);
});

test("editor has stable three-column layout and mutually exclusive mobile drawers", async () => {
  const css = await asset("editor.css");
  assert.match(css, /220px minmax\(0, 1fr\) 280px/);
  assert.match(css, /max-width: 899px/);
  assert.match(css, /\[data-drawer="tree"\]/);
  assert.match(css, /\[data-drawer="inspector"\]/);
  assert.match(css, /prefers-reduced-motion/);
});

test("save request is UTF-8 byte guarded and uses optimistic concurrency", async () => {
  const h = await helpers();
  const result = h.createSaveRequest("<p>ok</p>", '"v1"');
  assert.equal(result.method, "PUT");
  assert.equal(result.headers["Content-Type"], "text/html; charset=utf-8");
  assert.equal(result.headers["If-Match"], '"v1"');
  assert.equal(result.body, "<p>ok</p>");
  assert.throws(() => h.createSaveRequest("x", ""), /version/i);
  assert.doesNotThrow(() => h.createSaveRequest("a".repeat(30 * 1024 * 1024), "v1"));
  assert.throws(() => h.createSaveRequest("\u4e2d".repeat(10 * 1024 * 1024 + 1), "v1"), /30 MB/);
});

test("preview rejects non-HTTP protocols and supports relative public URLs", async () => {
  const h = await helpers();
  assert.equal(h.previewUrl("/view/a", "https://admin.example/editor.html"), "https://admin.example/view/a");
  assert.equal(h.previewUrl("https://page.example/view/a", "https://admin.example"), "https://page.example/view/a");
  assert.throws(() => h.previewUrl("javascript:alert(1)", "https://admin.example"), /preview/i);
});

test("text snapshots restore the same descendant objects and attributes", async () => {
  const h = await helpers();
  const text = { childNodes: [], nodeValue: "before" };
  const span = {
    attributes: [{ name: "data-business", value: "original", namespaceURI: null }], childNodes: [text], nodeValue: null,
    replaceChildren(...nodes) { this.childNodes = nodes; },
    removeAttributeNode(attr) { this.attributes.splice(this.attributes.indexOf(attr), 1); },
    setAttributeNS(namespaceURI, name, value) { this.attributes.push({ namespaceURI, name, value }); }
  };
  const root = { childNodes: [span], replaceChildren(...nodes) { this.childNodes = nodes; } };
  const snapshot = h.snapshotChildren(root);
  root.childNodes = [];
  text.nodeValue = "after";
  span.attributes = [];
  h.restoreChildren(root, snapshot);
  assert.equal(root.childNodes[0], span);
  assert.equal(span.childNodes[0], text);
  assert.equal(text.nodeValue, "before");
  assert.equal(span.attributes[0].value, "original");
});

test("workbench wires history, text sessions, artifact scrubbing and leave protection", async () => {
  const js = await asset("editor.js");
  for (const contract of [/EditorHistory/, /chooseEditableElement/, /assignEditorNodeIds/, /serializeDocument/, /beforeunload/, /If-Match/, /contenteditable/, /dblclick/, /paste/, /submit/, /focusout/, /getComputedStyle/, /cssText/, /401/, /409/, /413/]) assert.match(js, contract);
  assert.doesNotMatch(js, /allow-scripts/);
});

test("editor preserves the management UI CSRF handshake for every save", async () => {
  const js = await asset("editor.js");
  assert.match(js, /fetch\("\/api\/auth"/);
  assert.match(js, /X-CSRF-Token/);
  assert.match(js, /csrfToken/);
  assert.match(js, /uploadKind/);
});

test("raw property updates preserve CSS token boundaries and untouched declarations", async () => {
  const h = await helpers();
  const prefix = 'display:-moz-box;display:flex;--text:"a;\\\"b";--block:{a:b;c:d};background:url("data:image/svg+xml;a;b");';
  assert.equal(h.updateRawProperty(prefix + '/*keep;*/font-size:12px!important;', "font-size", "font-size: 25px;"), prefix + '/*keep;*/font-size: 25px;');
  assert.equal(h.updateRawProperty(prefix + 'FONT-SIZE:12px;f\\6f nt-size:14px;', "font-size", ""), prefix);
  assert.equal(h.updateRawProperty("color:red", "font-size", "font-size: 25px;"), "color:red;font-size: 25px;");
});

// Opt-in real browser coverage uses a caller-provided Playwright installation, not a runtime dependency.
if (process.env.EDITOR_PLAYWRIGHT_MODULE) {
  test("real browser editor acceptance", async (t) => {
    const { createRequire } = await import("node:module");
    const { createServer } = await import("node:http");
    const { mkdir } = await import("node:fs/promises");
    const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
    const original = `<!DOCTYPE html><html lang="en" contenteditable="true" data-hwb-editor-state="business-root"><head>
      <meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/escaped"><title>Fixture</title>
      <style data-hwb-editor-ui="business">body{margin:24px;font-family:Arial;background:#fff}section{padding:16px;background:#eef4ef}h1{font-size:28px}p{color:#345} .spacer{height:1100px}</style>
      <script>window.__uploadedScriptRan = true; parent.__uploadedScriptRan = true;</script></head><body>
      <section id="module" data-business="preserve"><h1 id="heading" contenteditable="false" spellcheck="true" data-hwb-editor-id="customer-id" data-hwb-selected="customer-selection">Original <em data-business="inline">heading</em></h1>
      <p id="text">Editable text</p><a href="/escaped" id="link">Stay here</a><form action="/escaped"><input value="original"><button>Submit</button></form></section>
      <div class="spacer"></div><footer>Footer</footer></body></html>`;
    let fixture = original;
    let publicUrl = "/view/test";
    let saved = "";
    let saveStatus = 200;
    let loadStatus = 200;
    let authStatus = 200;
    let saveDelay = 0;
    let currentVersion = '"v1"';
    const requests = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/auth") {
        requests.push({ method: req.method, path: url.pathname });
        res.writeHead(authStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: authStatus === 200, csrfToken: "browser-csrf" }));
        return;
      }
      if (url.pathname === "/view/test") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>Published preview</title><h1>Published preview</h1>");
        return;
      }
      if (url.pathname === "/api/uploads/test/content") {
        requests.push({ method: req.method, path: url.pathname, headers: req.headers });
        if (req.method === "PUT") {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          saved = Buffer.concat(chunks).toString();
          if (saveDelay) await new Promise((resolve) => setTimeout(resolve, saveDelay));
          if (req.headers["x-csrf-token"] !== "browser-csrf") { res.writeHead(403); res.end('{}'); return; }
          if (saveStatus === 200) currentVersion = '"v2"';
          res.writeHead(saveStatus, { "Content-Type": "application/json", ETag: currentVersion });
          res.end(JSON.stringify({ record: { title: "Fixture", url: "/view/test", uploadKind: "html" }, version: currentVersion }));
        } else {
          res.writeHead(loadStatus, { "Content-Type": "application/json", ETag: currentVersion });
          res.end(JSON.stringify({ html: fixture, record: { title: "Fixture", url: publicUrl, uploadKind: "html" }, version: currentVersion }));
        }
        return;
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) { res.writeHead(404); res.end(); return; }
      try {
        const data = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/html" });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(5000);
    const errors = [];
    const resourceRequests = [];
    page.on("request", (request) => { if (request.url().endsWith("fixture.css")) resourceRequests.push(request.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    const frame = () => page.frames().find((item) => item.parentFrame());
    const ready = async () => { await page.goto(`${origin}/editor.html?id=test`); await page.locator("#loadState").waitFor({ state: "hidden" }); };
    const selectHeading = async () => page.locator('.tree-row[title^="h1#heading"]').click();
    const changeSize = async (value) => { const input = page.getByRole("textbox", { name: "字号", exact: true }); await input.fill(value); await input.press("Tab"); };
    try {
      await t.test("I1 opaque open and closed shadow templates survive unrelated edit and save", async () => {
        const templates = ["open", "closed"].map((mode) => `<template shadowrootmode="${mode}" data-business="${mode}"><style>span{color:red}</style><span data-business="shadow">Shadow content</span><script>window.shadowFixture=true;</script><template shadowrootmode="closed"><b>Nested</b></template></template>`);
        fixture = `<html><head></head><body><h1 id="heading">Probe</h1>${templates.map((html) => `<div>${html}</div>`).join("")}</body></html>`;
        await ready(); await selectHeading(); await changeSize("25px");
        assert.equal(await frame().locator("body").evaluate((el) => [...el.querySelectorAll("div")].some((host) => host.shadowRoot)), false);
        await page.locator("#undoButton").click(); await page.locator("#redoButton").click();
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        for (const template of templates) assert.ok(saved.includes(template), saved);
        assert.doesNotMatch(saved, /data-hwb-editor-node-key|data-editor-helper/);
        await changeSize("26px"); await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        for (const template of templates) assert.ok(saved.includes(template), saved);
      });
      await t.test("I2 raw unrelated CSS survives property edits, undo, redo and save", async () => {
        const raw = 'color:oklch(60% 0.2 200);-moz-user-select:none;display:-moz-box;display:flex;--label:"a;b";/*keep;*/font-size:12px;';
        fixture = `<h1 id="heading" style='${raw}'>Probe</h1>`;
        await ready(); await selectHeading(); await changeSize("25px");
        const edited = await frame().locator("#heading").getAttribute("style");
        assert.ok(edited.startsWith(raw.split("/*keep;*/")[0]), edited);
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#heading").getAttribute("style"), raw);
        await page.locator("#redoButton").click();
        assert.equal(await frame().locator("#heading").getAttribute("style"), edited);
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        assert.match(saved, /-moz-user-select:none;display:-moz-box;display:flex;/);
      });
      await t.test("I3 public base precedes resources and original relative base survives save", async () => {
        const hits = [];
        const content = createServer((req, res) => { hits.push(req.url); res.writeHead(200, { "Content-Type": "text/css", "Access-Control-Allow-Origin": "*" }); res.end("#heading{color:rgb(10,120,30)}"); });
        await new Promise((resolve) => content.listen(0, "127.0.0.1", resolve));
        try {
          for (const csp of ["", '<meta http-equiv="Content-Security-Policy" content="base-uri \'none\'">']) for (const base of ["", '<base href="./assets/">']) {
            hits.length = 0;
            resourceRequests.length = 0;
            publicUrl = `http://127.0.0.1:${content.address().port}/view/test`;
            fixture = `<html><head>${csp}${base}<link rel="stylesheet" href="${base ? "fixture.css" : "./assets/fixture.css"}"></head><body><h1 id="heading">Probe</h1></body></html>`;
            await ready();
            assert.deepEqual(hits, ["/view/assets/fixture.css"]);
            assert.deepEqual(resourceRequests, [`http://127.0.0.1:${content.address().port}/view/assets/fixture.css`]);
            assert.equal(await frame().locator("#heading").evaluate((el) => getComputedStyle(el).color), "rgb(10, 120, 30)");
            await selectHeading(); await changeSize("25px"); await page.locator("#saveButton").click();
            await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
            if (base) assert.ok(saved.includes(base)); else assert.doesNotMatch(saved, /<base/);
            if (csp) assert.ok(saved.includes(csp));
          }
        } finally { publicUrl = "/view/test"; await new Promise((resolve) => content.close(resolve)); }
      });
      await t.test("I4 keyboard selection, text entry, commit, undo, redo and save", async () => {
        fixture = original; await ready();
        for (let i = 0; i < 30 && !(await page.locator('.tree-row[title="p#text"]').evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
        assert.equal(await page.locator('.tree-row[title="p#text"]').evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press("Enter");
        for (let i = 0; i < 40 && !(await page.locator("#editTextButton").evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        assert.equal(await frame().locator("#text").getAttribute("contenteditable"), "true");
        await page.keyboard.press("Control+a"); await page.keyboard.type("Keyboard revision"); await page.keyboard.press("Escape");
        assert.equal(await page.locator("#editTextButton").evaluate((el) => el === document.activeElement), true);
        await page.keyboard.press("Control+z");
        assert.equal(await frame().locator("#text").textContent(), "Editable text");
        await page.keyboard.press("Control+Shift+z"); await page.keyboard.press("Control+s");
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        assert.match(saved, /Keyboard revision/);
      });
      await t.test("M1 mobile drawers trap full forward and backward focus cycles", async () => {
        fixture = original; await ready(); await selectHeading(); await page.setViewportSize({ width: 390, height: 844 });
        for (const name of ["tree", "inspector"]) {
          await page.locator(`#${name}Toggle`).click();
          for (const key of ["Tab", "Shift+Tab"]) for (let i = 0; i < 40; i++) {
            await page.keyboard.press(key);
            assert.equal(await page.locator(`#${name}Panel`).evaluate((el) => el.contains(document.activeElement)), true);
          }
          await page.keyboard.press("Escape");
          assert.equal(await page.locator(`#${name}Toggle`).evaluate((el) => el === document.activeElement), true);
        }
        await page.locator("#inspectorToggle").click();
        await page.setViewportSize({ width: 1440, height: 960 });
        await page.waitForFunction(() => document.getElementById("workbench").dataset.drawer === "");
        assert.equal(await page.locator("#workbench").getAttribute("data-drawer"), "");
        assert.equal(await page.locator(".canvas-panel").evaluate((el) => el.inert), false);
      });
      await t.test("M2 non-RGB colors convert through sRGB and retain transparency", async () => {
        fixture = '<h1 id="heading" style="color:oklch(60% 0.2 200);background-color:color(display-p3 1 0 0 / 0.5)">Probe</h1>';
        await ready(); await selectHeading();
        const expected = await frame().locator("#heading").evaluate((el) => {
          const ctx = document.createElement("canvas").getContext("2d"); ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
          return '#' + [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');
        });
        assert.equal(await page.locator('[data-color="color"]').inputValue(), expected);
        assert.equal(await page.locator('[data-color="background-color"]').getAttribute("data-alpha"), String(128 / 255));
        await page.locator('[data-color="background-color"]').fill("#00ff00");
        await page.locator('[data-color="background-color"]').press("Tab");
        assert.equal(await frame().locator("#heading").evaluate((el) => getComputedStyle(el).backgroundColor), "rgba(0, 255, 0, 0.5)");
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        fixture = original;
      });
      await t.test("background swatch colors transparent elements with undo redo and save", async () => {
        fixture = '<h1 id="heading">Transparent background</h1>';
        await ready(); await selectHeading();
        const background = () => frame().locator("#heading").evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.equal(await background(), "rgba(0, 0, 0, 0)");
        await page.locator('[data-color="background-color"]').fill("#00ff00");
        await page.locator('[data-color="background-color"]').press("Tab");
        assert.equal(await background(), "rgb(0, 255, 0)");
        await page.locator("#undoButton").click();
        assert.equal(await background(), "rgba(0, 0, 0, 0)");
        await page.locator("#redoButton").click();
        assert.equal(await background(), "rgb(0, 255, 0)");
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        assert.match(saved, /background-color: rgb\(0, 255, 0\)/);
        fixture = original;
      });
      await t.test("safe mount, original scripts paused, navigation blocked, tree and parent/child selection", async () => {
        await ready();
        assert.equal(await page.locator("#editorCanvas").getAttribute("sandbox"), "allow-same-origin");
        assert.equal(await frame().evaluate(() => window.__uploadedScriptRan), undefined);
        assert.equal(await page.evaluate(() => window.__uploadedScriptRan), undefined);
        assert.equal(frame().url(), "about:srcdoc");
        await frame().locator("#link").click();
        assert.equal(frame().url(), "about:srcdoc");
        await selectHeading();
        assert.match(await page.locator("#selectionLabel").textContent(), /h1#heading/);
        await page.locator("#parentButton").click();
        assert.equal(await page.locator("#selectionLabel").textContent(), "section#module");
        await page.locator("#childButton").click();
        assert.match(await page.locator("#selectionLabel").textContent(), /h1#heading/);
      });
      await t.test("inline controls validate, create history, undo and redo", async () => {
        await changeSize("32px");
        assert.equal(await frame().locator("#heading").evaluate((el) => el.style.fontSize), "32px");
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#heading").getAttribute("style"), null);
        await page.locator("#redoButton").click();
        assert.equal(await frame().locator("#heading").evaluate((el) => el.style.fontSize), "32px");
        await changeSize("bad-value");
        assert.equal(await frame().locator("#heading").evaluate((el) => el.style.fontSize), "32px");
        assert.match(await page.locator("#message").textContent(), /无效/);
        await changeSize("32px");
      });
      await t.test("text undo preserves descendant identity for older style commands", async () => {
        await page.locator('.tree-row[title="em"]').click();
        await changeSize("18px");
        await frame().locator("#heading").dblclick({ position: { x: 12, y: 12 } });
        await frame().locator("#heading").fill("Replacement heading");
        await page.locator("#documentTitle").click();
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#heading em").evaluate((el) => el.style.fontSize), "18px");
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#heading em").getAttribute("style"), null);
      });
      await t.test("double-click text edit commits once and survives undo/redo", async () => {
        await frame().locator("#text").dblclick();
        await frame().locator("#text").fill("Revised text");
        assert.equal(await page.locator("#saveButton").isEnabled(), true);
        await page.locator("#documentTitle").click();
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#text").textContent(), "Editable text");
        await page.locator("#redoButton").click();
        assert.equal(await frame().locator("#text").textContent(), "Revised text");
      });
      await t.test("delete and undo restore exact sibling order", async () => {
        await page.locator('.tree-row[title="p#text"]').click();
        await page.locator("#deleteButton").click();
        assert.equal(await frame().locator("#text").count(), 0);
        await page.locator("#undoButton").click();
        assert.equal(await frame().locator("#text").evaluate((el) => el.nextElementSibling.id), "link");
      });
      await t.test("advanced CSS applies and rejects wholly invalid CSS", async () => {
        await selectHeading();
        await page.locator("#styleInspector summary").click();
        await page.locator("#advancedCss").fill("font-size: 35px; color: rgb(20, 90, 70);");
        await page.locator("#applyCssButton").click();
        assert.equal(await frame().locator("#heading").evaluate((el) => el.style.fontSize), "35px");
        await page.locator("#advancedCss").fill("this is invalid");
        await page.locator("#applyCssButton").click();
        assert.equal(await page.locator("#advancedCss").getAttribute("aria-invalid"), "true");
        await page.locator("#advancedCss").fill("font-size: 35px; color: rgb(20, 90, 70);");
        await page.locator("#applyCssButton").click();
      });
      await t.test("save uses session CSRF and ETag, scrubs only owned artifacts, clears history", async () => {
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("message").textContent.includes("已保存并发布"));
        const put = requests.find((r) => r.method === "PUT");
        assert.equal(put.headers["if-match"], '"v1"');
        assert.equal(put.headers["x-csrf-token"], "browser-csrf");
        assert.match(saved, /<!DOCTYPE html>/);
        assert.match(saved, /<script>window.__uploadedScriptRan/);
        assert.match(saved, /http-equiv="refresh"/);
        assert.match(saved, /data-hwb-editor-id="customer-id"/);
        assert.match(saved, /contenteditable="false" spellcheck="true"/);
        assert.match(saved, /data-hwb-selected="customer-selection"/);
        assert.match(saved, /data-hwb-editor-state="business-root"/);
        assert.match(saved, /data-hwb-editor-ui="business"/);
        assert.match(saved, /Revised text/);
        assert.doesNotMatch(saved, /data-editor-helper|data-hwb-editor-node-key|script-src 'none'/);
        assert.equal(await page.locator("#undoButton").isDisabled(), true);
        assert.equal(await page.locator("#saveButton").isDisabled(), true);
      });
      await t.test("unblurred property drafts are dirty and Ctrl+S commits the current value", async () => {
        const input = page.getByRole("textbox", { name: "字号", exact: true });
        await input.fill("36px");
        assert.equal(await page.locator("#saveButton").isEnabled(), true);
        await input.press("Control+s");
        await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
        assert.match(saved, /font-size: 36px/);
      });
      await t.test("toolbar undo can commit and undo the first active text session", async () => {
        const isolated = await browser.newPage();
        isolated.setDefaultTimeout(5000);
        try {
          await isolated.goto(`${origin}/editor.html?id=test`);
          await isolated.locator("#loadState").waitFor({ state: "hidden" });
          const inner = isolated.frames().find((item) => item.parentFrame());
          await inner.locator("#text").dblclick();
          await inner.locator("#text").fill("First text edit");
          assert.equal(await isolated.locator("#undoButton").isEnabled(), true);
          await isolated.locator("#undoButton").click();
          assert.equal(await inner.locator("#text").textContent(), "Editable text");
        } finally { await isolated.close(); }
      });
      await t.test("conflicts and server failures retain dirty changes and version", async () => {
        await changeSize("37px");
        for (const status of [409, 413, 500, 401]) {
          saveStatus = status;
          await page.locator("#saveButton").click();
          await page.waitForFunction(() => !document.getElementById("saveButton").disabled);
          assert.equal(await frame().locator("#heading").evaluate((el) => el.style.fontSize), "37px");
          assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "true");
          assert.equal(page.url(), `${origin}/editor.html?id=test`);
        }
        authStatus = 401;
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => !document.getElementById("saveButton").disabled);
        assert.equal(page.url(), `${origin}/editor.html?id=test`);
        authStatus = 200;
        await page.route("**/api/uploads/test/content", (route) => route.request().method() === "PUT" ? route.abort() : route.continue());
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => !document.getElementById("saveButton").disabled);
        assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "true");
        await page.unroute("**/api/uploads/test/content");
        saveStatus = 200;
        saveDelay = 300;
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("workbench").dataset.busy === "true");
        assert.equal(await page.locator("#editorCanvas").evaluate((el) => el.inert), true);
        await page.waitForFunction(() => document.getElementById("message").textContent.includes("已保存并发布"));
        saveDelay = 0;
        assert.equal(requests.filter((r) => r.method === "PUT").at(-1).headers["if-match"], '"v2"');
      });
      await t.test("preview opens published URL without changing dirty state", async () => {
        await changeSize("39px");
        const popupPromise = page.waitForEvent("popup");
        await page.locator("#previewButton").click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        assert.equal(popup.url(), `${origin}/view/test`);
        assert.equal(await page.locator("#saveButton").isEnabled(), true);
        await popup.close();
      });
      await t.test("dirty navigation is protected", async () => {
        const dialogPromise = page.waitForEvent("dialog").then(async (dialog) => {
          assert.equal(dialog.type(), "beforeunload");
          await dialog.dismiss();
        });
        await Promise.all([dialogPromise, page.locator("#backLink").click({ noWaitAfter: true })]);
        assert.equal(page.url(), `${origin}/editor.html?id=test`);
        await page.locator("#saveButton").click();
        await page.waitForFunction(() => document.getElementById("message").textContent.includes("已保存并发布"));
      });
      await t.test("desktop and mobile layout remain non-overlapping with exclusive drawers", async () => {
        const output = process.env.EDITOR_SCREENSHOT_DIR;
        if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: `${output}/editor-desktop.png`, fullPage: true }); }
        for (const width of [899, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          const before = await page.locator("#editorCanvas").boundingBox();
          await page.locator("#treeToggle").click();
          assert.equal(await page.locator("#treePanel").isVisible(), true);
          assert.equal(await page.locator("#inspectorPanel").isVisible(), false);
          await page.keyboard.press("Escape");
          await page.locator("#inspectorToggle").click();
          assert.equal(await page.locator("#treePanel").isVisible(), false);
          assert.equal(await page.locator("#inspectorPanel").isVisible(), true);
          assert.deepEqual(await page.locator("#editorCanvas").boundingBox(), before);
          if (output && width === 390) await page.screenshot({ path: `${output}/editor-mobile.png`, fullPage: true });
          await page.keyboard.press("Escape");
        }
      });
      await t.test("load failure retries, missing ID errors, initial 401 redirects", async () => {
        loadStatus = 404;
        await page.goto(`${origin}/editor.html?id=test`);
        await page.locator("#retryButton").waitFor({ state: "visible" });
        assert.match(await page.locator("#loadMessage").textContent(), /不存在/);
        loadStatus = 200;
        await page.locator("#retryButton").click();
        await page.locator("#loadState").waitFor({ state: "hidden" });
        await page.goto(`${origin}/editor.html`);
        await page.waitForFunction(() => document.getElementById("loadMessage").textContent.includes("缺少"));
        authStatus = 401;
        await page.goto(`${origin}/editor.html?id=test`);
        await page.waitForURL(/login.html\?next=/);
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
