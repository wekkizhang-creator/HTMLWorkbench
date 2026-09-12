import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=";
const fixture = `<!doctype html><html><head><style>body{margin:0}.stage,.slide{width:1440px;height:810px}.slide{display:flex;flex-direction:column;padding:60px;box-sizing:border-box;background:white;font:24px Arial}.slide[hidden]{display:none}img{width:300px;height:180px}</style></head><body><main class="stage"><section class="slide"><header><h1 id="one">First page</h1></header></section><section class="slide" hidden><header><h2 id="two"><span>Second page</span></h2></header><img id="photo" src="data:image/png;base64,${png}"></section><section class="slide" hidden><h2>Third page</h2></section></main><script id="notes-data" type="application/json">["First note","Second note","Third note"]</script><script>window.originalScript=true;</script></body></html>`;

test("editor refinements browser acceptance", { skip: !process.env.EDITOR_PLAYWRIGHT_MODULE, timeout: 120000 }, async t => {
  const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (!/^\/[\w.-]+$/.test(path)) { res.writeHead(404); res.end(); return; }
    try {
      const data = await readFile(new URL(`../public${path}`, import.meta.url));
      res.setHeader("Content-Type", /\.m?js$/.test(path) ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  async function openEditor(subtest, { storageUnavailable = false, controlledDrafts = false, html = fixture } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
    subtest.after(() => context.close());
    if (storageUnavailable) await context.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: null }));
    if (controlledDrafts) await context.route("**/editor-drafts.mjs", route => route.fulfill({
      contentType: "text/javascript",
      body: `import { createDraftStore as realStore } from "/editor-drafts.mjs?real";
        export function createDraftStore() {
          const store = realStore();
          const control = window.draftIO = { calls: [], hold: null };
          return { ...store, ...Object.fromEntries(["write", "remove"].map(method => [method, async (...args) => {
            control.calls.push({ method, args });
            if (control.hold === method) {
              control.hold = null;
              await new Promise((resolve, reject) => {
                control.release = resolve;
                control.fail = () => reject(new Error("Synthetic storage failure"));
              });
              control.release = null;
            }
            return store[method](...args);
          }])) };
        }`
    }));
    const state = { html, version: '"v1"', writes: [], saveStatus: 200 };
    await context.route("**/api/**", async route => {
      const request = route.request();
      if (request.url().endsWith("/api/auth")) {
        await route.fulfill({ json: { authenticated: true, csrfToken: "test" } }); return;
      }
      if (request.method() === "PUT") {
        state.writes.push({ html: request.postData(), version: request.headers()["if-match"] });
        if (state.saveStatus !== 200) { await route.fulfill({ status: state.saveStatus, json: {} }); return; }
        if (request.headers()["if-match"] !== state.version) { await route.fulfill({ status: 409, json: {} }); return; }
        state.html = request.postData();
        state.version = '"v2"';
      }
      await route.fulfill({ json: { html: state.html, version: state.version, record: { title: "Refinement", uploadKind: "html", url: `${origin}/view/test` } } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("dialog", dialog => dialog.accept());
    await page.goto(`${origin}/editor.html?id=test`);
    await page.locator("#loadState").waitFor({ state: "hidden" });
    return { page, context, state, frame: page.frameLocator("#editorCanvas") };
  }
  async function waitDraft(page) {
    await page.waitForFunction(() => document.getElementById("draftState")?.textContent.includes("本地草稿已保存"));
  }
  async function drafts(page) {
    return page.evaluate(async () => {
      const store = (await import("/editor-drafts.mjs?real")).createDraftStore();
      try { return await store.list("test"); } finally { store.close(); }
    });
  }
  async function waitCleanDraft(page) {
    await page.waitForFunction(() => document.getElementById("draftState").textContent === "");
    assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "false");
  }
  async function download(page, button) {
    const pending = page.waitForEvent("download");
    await page.locator(button).click();
    const file = await pending;
    return readFile(await file.path(), "utf8");
  }

  await t.test("direct heading selection and cross-page history update the affected preview", async subtest => {
    const { page, frame } = await openEditor(subtest);
    await page.locator(".slide-item").nth(1).click();
    await frame.locator("#two span").click();
    assert.match(await page.locator("#selectionLabel").textContent(), /^h2#two/);
    await frame.locator("#two").dblclick();
    await frame.locator("#two").fill("Changed heading");
    await page.locator(".slide-item").nth(2).click();
    await page.waitForTimeout(400);
    await page.locator("#undoButton").click();
    assert.equal(await page.locator("#pageIndicator").textContent(), "2 / 3");
    assert.equal(await frame.locator("#two").textContent(), "Second page");
    await page.waitForFunction(() => !document.querySelectorAll(".slide-item")[1].querySelector("iframe").srcdoc.includes("Changed heading"));
    await page.locator("#redoButton").click();
    assert.equal(await frame.locator("#two").textContent(), "Changed heading");
  });

  await t.test("selecting unchanged content does not rebuild previews", async subtest => {
    const { page, frame } = await openEditor(subtest);
    await page.locator(".slide-item").nth(1).click();
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.previewWrites = 0;
      new MutationObserver(list => window.previewWrites += list.length).observe(document.getElementById("slideList"), { subtree: true, attributes: true, attributeFilter: ["srcdoc"] });
    });
    for (let i = 0; i < 3; i++) { await frame.locator("#photo").click(); await page.waitForTimeout(350); }
    assert.equal(await page.evaluate(() => window.previewWrites), 0);
  });

  await t.test("unblurred text and notes survive reload by explicit draft recovery", async subtest => {
    const { page, frame, state } = await openEditor(subtest);
    await frame.locator("#one").dblclick();
    await frame.locator("#one").fill("Unsaved recovered heading");
    await waitDraft(page);
    await page.reload();
    await page.locator("#draftRecovery").waitFor({ state: "visible" });
    assert.equal(await frame.locator("#one").textContent(), "First page");
    await page.locator("#restoreDraftButton").click();
    await page.locator("#loadState").waitFor({ state: "hidden" });
    assert.equal(await frame.locator("#one").textContent(), "Unsaved recovered heading");
    assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "true");
    await page.locator("#notesPanel summary").click();
    await page.locator("#notesEditor").fill("<p>Unblurred note </script></p>");
    await waitDraft(page);
    const exported = await download(page, "#exportButton");
    assert.match(exported, /Unsaved recovered heading/);
    assert.match(exported, /window.originalScript=true/);
    assert.doesNotMatch(exported, /data-hwb-editor|data-hwb-presentation|data-editor-helper/);
    const parsedNotes = exported.match(/<script id="notes-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    assert.equal(JSON.parse(parsedNotes)[0], "<p>Unblurred note </script></p>");
    assert.equal(state.writes.length, 0);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
    await page.reload();
    await page.locator("#loadState").waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
    assert.equal(await page.locator("#draftRecovery").isVisible(), false);
  });

  await t.test("returning unblurred text to its original removes only the current owner's persisted draft", async subtest => {
    const { page, frame, state } = await openEditor(subtest);
    const heading = frame.locator("#one");
    await heading.dblclick();
    await heading.fill("Obsolete pending heading");
    await waitDraft(page);
    const [obsolete] = await drafts(page);
    assert.match(obsolete.html, /Obsolete pending heading/);
    const other = { ...obsolete, ownerId: "other-tab", html: fixture.replace("First page", "Other tab heading") };
    await page.evaluate(async entry => {
      const store = (await import("/editor-drafts.mjs?real")).createDraftStore();
      try { await store.write(entry); } finally { store.close(); }
    }, other);
    await heading.fill("First page");
    assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "false");
    assert.equal(await heading.evaluate(el => el === el.ownerDocument.activeElement), true);
    await waitCleanDraft(page);
    assert.deepEqual(await drafts(page), [other]);
    await page.reload();
    await page.locator("#draftRecovery").waitFor({ state: "visible" });
    assert.match(await download(page, "#exportDraftButton"), /Other tab heading/);
    await page.locator("#discardDraftButton").click();
    await page.locator("#draftRecovery").waitFor({ state: "hidden" });
    assert.deepEqual(await drafts(page), []);
    assert.equal(state.writes.length, 0);
  });

  for (const next of ["clean", "later edit", "new load"]) {
    await t.test(`clean draft removal waits for outstanding writes and preserves ${next}`, async subtest => {
      const { page, frame } = await openEditor(subtest, { controlledDrafts: true });
      await page.evaluate(() => { window.draftIO.hold = "write"; });
      await frame.locator("#one").dblclick();
      await frame.locator("#one").fill("Outstanding obsolete write");
      await page.waitForFunction(() => Boolean(window.draftIO.release));
      await frame.locator("#one").fill("First page");
      assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "false");
      assert.equal(await page.evaluate(() => window.draftIO.calls.some(call => call.method === "remove")), false);
      if (next === "new load") {
        // Exercise an in-page load without destroying the outstanding promise queue.
        await page.locator("#retryButton").evaluate(button => button.click());
        await page.locator("#loadState").waitFor({ state: "hidden" });
        await frame.locator("#one").dblclick();
      }
      if (next !== "clean") {
        await frame.locator("#one").fill("Newer pending heading");
        await page.waitForTimeout(850);
      }
      await page.evaluate(() => window.draftIO.release());
      if (next === "clean") {
        await waitCleanDraft(page);
        assert.deepEqual(await drafts(page), []);
        await page.reload();
        await page.locator("#loadState").waitFor({ state: "hidden" });
        assert.deepEqual(await drafts(page), []);
        assert.equal(await page.locator("#draftRecovery").isVisible(), false);
      } else {
        await waitDraft(page);
        const entries = await drafts(page);
        assert.equal(entries.length, 1);
        assert.match(entries[0].html, /Newer pending heading/);
        const calls = await page.evaluate(() => window.draftIO.calls);
        assert.deepEqual(calls.map(call => call.method), ["write", "remove", "write"]);
        assert.equal(calls[1].args[1], calls[0].args[0].ownerId);
        if (next === "new load") assert.notEqual(entries[0].ownerId, calls[0].args[0].ownerId);
      }
    });
  }

  for (const fail of [false, true]) {
    await t.test(`delayed clean draft removal ${fail ? "failure" : "completion"} does not clear later-edit status`, async subtest => {
      const { page, frame } = await openEditor(subtest, { controlledDrafts: true });
      await frame.locator("#one").dblclick();
      await frame.locator("#one").fill("Previously persisted heading");
      await waitDraft(page);
      await page.evaluate(() => { window.draftIO.hold = "remove"; });
      await frame.locator("#one").fill("First page");
      await page.waitForFunction(() => Boolean(window.draftIO.release));
      await frame.locator("#one").fill("Later pending heading");
      await page.evaluate(shouldFail => {
        window.draftIO.hold = "write";
        if (shouldFail) window.draftIO.fail(); else window.draftIO.release();
      }, fail);
      await page.waitForFunction(() => window.draftIO.calls.filter(call => call.method === "write").length === 2);
      assert.equal(await page.locator("#draftState").textContent(), "草稿待保存");
      await page.evaluate(() => window.draftIO.release());
      await waitDraft(page);
      const entries = await drafts(page);
      assert.equal(entries.length, 1);
      assert.match(entries[0].html, /Later pending heading/);
    });
  }

  await t.test("a stale draft is export-only and never changes the published base", async subtest => {
    const { page, frame, state } = await openEditor(subtest);
    await frame.locator("#one").dblclick();
    await frame.locator("#one").fill("Older local draft");
    await waitDraft(page);
    state.version = '"newer-server-version"';
    state.html = fixture.replace("First page", "Newer server content");
    await page.reload();
    await page.locator("#draftRecovery").waitFor({ state: "visible" });
    assert.equal(await page.locator("#restoreDraftButton").isDisabled(), true);
    assert.equal(await frame.locator("#one").textContent(), "Newer server content");
    assert.match(await download(page, "#exportDraftButton"), /Older local draft/);
    assert.equal(state.writes.length, 0);
    await page.locator("#discardDraftButton").click();
    await page.locator("#draftRecovery").waitFor({ state: "hidden" });
  });

  await t.test("pending valid property values are stored without mutating the canvas", async subtest => {
    const { page, frame } = await openEditor(subtest);
    await frame.locator("#one").click();
    await page.getByRole("textbox", { name: "字号", exact: true }).fill("38px");
    await waitDraft(page);
    assert.equal(await frame.locator("#one").getAttribute("style"), null);
    const storedSize = await page.evaluate(async () => {
      const store = (await import("/editor-drafts.mjs")).createDraftStore();
      try { return new DOMParser().parseFromString((await store.list("test"))[0].html, "text/html").getElementById("one").style.fontSize; }
      finally { store.close(); }
    });
    assert.equal(storedSize, "38px");
  });

  await t.test("saving one tab does not remove a second tab's draft", async subtest => {
    const { page, frame, context } = await openEditor(subtest);
    await frame.locator("#one").dblclick(); await frame.locator("#one").fill("First tab draft");
    await waitDraft(page);
    const second = await context.newPage();
    second.on("dialog", dialog => dialog.accept());
    await second.goto(page.url());
    await second.locator("#loadState").waitFor({ state: "hidden" });
    const secondHeading = second.frameLocator("#editorCanvas").locator("#one");
    await secondHeading.dblclick(); await secondHeading.fill("Second tab draft");
    await waitDraft(second);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
    const drafts = await second.evaluate(async () => {
      const store = (await import("/editor-drafts.mjs")).createDraftStore();
      try { return await store.list("test"); } finally { store.close(); }
    });
    assert.equal(drafts.length, 1);
    assert.match(drafts[0].html, /Second tab draft/);
    await second.locator("#saveButton").click();
    await second.waitForFunction(() => document.getElementById("message").textContent.includes("版本冲突"));
  });

  await t.test("server conflicts keep the local draft and export available", async subtest => {
    const { page, frame, state } = await openEditor(subtest);
    await frame.locator("#one").dblclick();
    await frame.locator("#one").fill("Conflict draft");
    await waitDraft(page);
    state.saveStatus = 409;
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("message").textContent.includes("版本冲突"));
    assert.match(await download(page, "#exportButton"), /Conflict draft/);
    await page.reload();
    await page.locator("#draftRecovery").waitFor({ state: "visible" });
  });

  await t.test("unavailable IndexedDB does not block export or server save", async subtest => {
    const { page, frame, state } = await openEditor(subtest, { storageUnavailable: true });
    await frame.locator("#one").dblclick();
    await frame.locator("#one").fill("No storage edit");
    await page.waitForFunction(() => document.getElementById("draftState")?.textContent.includes("不可用"));
    assert.match(await download(page, "#exportButton"), /No storage edit/);
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
    assert.match(state.html, /No storage edit/);
  });

  await t.test("zoom, pan and fit preserve logical geometry and selection alignment", async subtest => {
    const { page, frame } = await openEditor(subtest);
    await page.locator(".slide-item").nth(1).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator("#zoomLevel").fill("100");
      await page.locator("#zoomLevel").press("Enter");
      assert.equal(await frame.locator(".slide").nth(1).evaluate(el => el.getBoundingClientRect().width), 1440);
      await frame.locator("#photo").click();
      const image = await frame.locator("#photo").boundingBox();
      const outline = await page.locator("#selectionOutline").boundingBox();
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(image[key] - outline[key]) < 2, `${key} at ${width}`);
      await page.locator("#panButton").click();
      const viewport = await page.locator("#canvasViewport").boundingBox();
      const before = await page.locator("#canvasViewport").evaluate(el => el.scrollLeft);
      await page.mouse.move(viewport.x + 150, viewport.y + 100);
      await page.mouse.down(); await page.mouse.move(viewport.x + 70, viewport.y + 100); await page.mouse.up();
      const after = await page.locator("#canvasViewport").evaluate(el => el.scrollLeft);
      assert.ok(after > before);
      await page.locator("#fitCanvasButton").click();
      await page.waitForTimeout(100);
      const fit = await page.locator("#editorCanvas").boundingBox();
      assert.ok(fit.width <= viewport.width);
      assert.ok(Math.abs(fit.width / fit.height - 16 / 9) < .01);
    }
  });

  await t.test("fit below manual zoom minimum does not turn zoom-out into zoom-in", async subtest => {
    const { page } = await openEditor(subtest, { html: fixture.replaceAll("1440px", "16000px").replaceAll("810px", "9000px") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    assert.ok(Number(await page.locator("#zoomLevel").inputValue()) < 10);
    assert.equal(await page.locator("#zoomOutButton").isDisabled(), true);
  });
});
