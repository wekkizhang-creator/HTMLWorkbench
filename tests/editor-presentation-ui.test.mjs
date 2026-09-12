import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";

test("presentation editing preserves pages, images, notes and playback", { skip: !process.env.EDITOR_PLAYWRIGHT_MODULE, timeout: 90000 }, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=";
  const original = `<!doctype html><html><head><style>body{margin:0}.stage{width:1440px;height:810px;transform:scale(.5);transform-origin:0 0}.slide{display:flex;flex-direction:column;box-sizing:border-box;width:1440px;height:810px;padding:60px;background:#fff;color:#172b24;font:24px Arial}.slide[hidden]{display:none}img{width:300px;height:180px;object-fit:contain}@media(max-width:800px){.slide{width:100%;height:auto}}</style></head><body><main class="viewport"><div class="stage"><section class="slide" data-title="First" aria-hidden="false"><h1 id="one">First page</h1></section><section class="slide" data-title="Second" hidden aria-hidden="true"><h1 id="two">Second page</h1><picture><source srcset="data:image/png;base64,${png}"><img id="photo" src="data:image/png;base64,${png}" alt="Sample" width="300" height="180"></picture></section><section class="slide" data-title="Third" hidden aria-hidden="true"><h1>Third page</h1></section></div></main><nav id="playControls"><button id="next">Next</button></nav><script type="application/json" id="notes-data">["<p>First note</p>","<p>Second note</p>","<p>Third note</p>"]</script><script>window.playback=true;const slides=[...document.querySelectorAll('.slide')];let i=0;document.getElementById('next').onclick=()=>{i=(i+1)%slides.length;slides.forEach((s,n)=>s.hidden=n!==i);};</script></body></html>`;
  let fixture = process.env.PRESENTATION_SAMPLE_PATH ? await readFile(process.env.PRESENTATION_SAMPLE_PATH, "utf8") : original;
  let saved = "";
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    if (pathname === "/api/auth") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ authenticated: true, csrfToken: "test" })); return; }
    if (pathname === "/api/uploads/test/content") {
      if (req.method === "PUT") { const chunks = []; for await (const chunk of req) chunks.push(chunk); saved = Buffer.concat(chunks).toString(); }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ html: fixture, record: { title: "Presentation", url: `http://127.0.0.1:${server.address().port}/view/test`, uploadKind: "html" }, version: '"v1"' })); return;
    }
    if (pathname === "/view/test") { res.setHeader("Content-Type", "text/html"); res.end(saved || fixture); return; }
    if (!/^\/[\w.-]+$/.test(pathname)) { res.writeHead(404); res.end(); return; }
    try { const data = await readFile(new URL(`../public${pathname}`, import.meta.url)); res.setHeader("Content-Type", /\.m?js$/.test(pathname) ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html"); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(`${origin}/editor.html?id=test`);
    await page.locator("#loadState").waitFor({ state: "hidden" });
    const frame = page.frameLocator("#editorCanvas");
    const expectedCount = process.env.PRESENTATION_SAMPLE_PATH ? 23 : 3;
    assert.equal(await page.locator(".slide-item").count(), expectedCount);
    for (let index = 0; index < expectedCount; index++) {
      await page.locator(".slide-item").nth(index).click();
      const bounds = await frame.locator(".slide").nth(index).evaluate(el => {
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height, footerBottom: el.querySelector(".footer")?.getBoundingClientRect().bottom, bottom: rect.bottom };
      });
      assert.equal(Math.round(bounds.width), 1440);
      assert.equal(Math.round(bounds.height), 810);
      if (bounds.footerBottom !== undefined) assert.ok(bounds.footerBottom <= bounds.bottom + 1, `page ${index + 1} footer fits`);
    }
    assert.equal(await page.locator("#saveState").getAttribute("data-dirty"), "false");
    await page.locator(".slide-item").nth(1).click();
    const slides = frame.locator(".slide");
    assert.equal(await slides.nth(0).isVisible(), false);
    assert.equal(await slides.nth(1).isVisible(), true);
    assert.equal(await slides.nth(1).evaluate(el => Math.round(el.getBoundingClientRect().width)), 1440);
    const heading = slides.nth(1).locator("h1,h2").first();
    await heading.dblclick();
    await heading.fill("Edited presentation heading");
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
    assert.match(saved, /Edited presentation heading/);
    assert.equal((saved.match(/class="slide(?:\s|"|')/g) || []).length, expectedCount);
    await page.locator("#notesPanel summary").click();
    const note = '<p>Updated note &amp; source</p><p>literal </script> boundary</p>';
    await page.locator("#notesEditor").fill(note);
    await page.locator(".slide-item").nth(2).click();
    await page.locator(".slide-item").nth(1).click();
    assert.equal(await page.locator("#notesEditor").inputValue(), note);
    await page.locator("#undoButton").click();
    assert.notEqual(await page.locator("#notesEditor").inputValue(), note);
    await page.locator("#redoButton").click();
    assert.equal(await page.locator("#notesEditor").inputValue(), note);
    if (!process.env.PRESENTATION_SAMPLE_PATH) {
      await frame.locator("#photo").click();
      const oldSrc = await frame.locator("#photo").getAttribute("src");
      const replacement = await page.evaluate(async () => { const canvas = document.createElement("canvas"); canvas.width = 12; canvas.height = 8; const ctx = canvas.getContext("2d"); ctx.fillStyle = "green"; ctx.fillRect(0,0,12,8); return canvas.toDataURL().split(",")[1]; });
      await page.locator("#imageFile").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: Buffer.from(replacement, "base64") });
      await page.waitForFunction(() => document.getElementById("imageStatus").textContent === "图片已替换");
      assert.notEqual(await frame.locator("#photo").getAttribute("src"), oldSrc);
      assert.equal(await frame.locator("source").getAttribute("srcset"), null);
      await page.locator("#undoButton").click();
      assert.equal(await frame.locator("#photo").getAttribute("src"), oldSrc);
      await page.locator("#redoButton").click();
    }
    await page.locator("#saveButton").click();
    await page.waitForFunction(() => document.getElementById("saveState").dataset.dirty === "false");
    const published = await browser.newPage();
    await published.goto(`${origin}/view/test`);
    const notes = await published.locator("#notes-data").textContent();
    assert.equal(JSON.parse(notes)[1], note);
    if (!process.env.PRESENTATION_SAMPLE_PATH) {
      assert.equal(await published.evaluate(() => window.playback), true);
      assert.equal(await published.locator(".slide").nth(1).getAttribute("aria-hidden"), "true");
      await published.locator("#next").click();
      assert.equal(await published.locator("#two").textContent(), "Edited presentation heading");
      assert.equal(await published.locator("#two").isVisible(), true);
    } else {
      assert.equal(await published.evaluate(() => window.presentation.count), expectedCount);
      await published.evaluate(() => window.presentation.go(1));
      assert.equal(await published.locator(".slide").nth(1).isVisible(), true);
      assert.equal(await published.locator(".slide").nth(1).locator("h1,h2").first().textContent(), "Edited presentation heading");
    }
    for (const width of [1440,390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      await page.waitForTimeout(300);
      const geometry = await page.locator("#editorCanvas").evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, viewport: el.parentElement.getBoundingClientRect().width }));
      assert.ok(Math.abs(geometry.width / geometry.height - 16 / 9) < .01);
      assert.ok(geometry.width <= geometry.viewport + 1);
      const selectedImage = slides.nth(1).locator("img").first();
      await selectedImage.click();
      const headingBox = await selectedImage.boundingBox();
      const outlineBox = await page.locator("#selectionOutline").boundingBox();
      assert.ok(outlineBox);
      for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(headingBox[key] - outlineBox[key]) < 2, `scaled outline ${key} at ${width}`);
      if (process.env.EDITOR_SCREENSHOT_DIR) {
        await mkdir(process.env.EDITOR_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.EDITOR_SCREENSHOT_DIR}/presentation-${process.env.PRESENTATION_SAMPLE_PATH ? "real" : "fixture"}-${width}.png` });
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
