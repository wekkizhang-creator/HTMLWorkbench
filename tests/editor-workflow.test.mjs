import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("live list-to-editor publishing and rollback on desktop and mobile", {
  skip: !process.env.EDITOR_PLAYWRIGHT_MODULE,
  timeout: 90000
}, async () => {
  const { chromium } = createRequire(import.meta.url)(process.env.EDITOR_PLAYWRIGHT_MODULE);
  const dataDir = await mkdtemp(path.join(tmpdir(), "hwb-editor-workflow-"));
  const adminPort = await freePort();
  const contentPort = await freePort();
  const admin = `http://127.0.0.1:${adminPort}`;
  const content = `http://127.0.0.1:${contentPort}`;
  const env = {
    ...process.env, NODE_ENV: "development", VERCEL: "0", BLOB_READ_WRITE_TOKEN: "", HOST: "127.0.0.1",
    HTML_WORKBENCH_ADMIN_ORIGIN: admin, HTML_WORKBENCH_PUBLIC_ORIGIN: content,
    HTML_WORKBENCH_PASSWORD: randomBytes(16).toString("hex"),
    HTML_WORKBENCH_AUTH_SECRET: randomBytes(32).toString("hex"),
    HTML_WORKBENCH_CURSOR_SECRET: randomBytes(32).toString("hex"),
    HTML_WORKBENCH_DATA_DIR: dataDir
  };
  const children = [
    spawn(process.execPath, ["server.js"], { env: { ...env, PORT: String(adminPort), HTML_WORKBENCH_ROLE: "admin" }, windowsHide: true, stdio: "ignore" }),
    spawn(process.execPath, ["server.js"], { env: { ...env, PORT: String(contentPort), HTML_WORKBENCH_ROLE: "content" }, windowsHide: true, stdio: "ignore" })
  ];
  let browser;
  try {
    for (const origin of [admin, content]) {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${origin}/healthz`)).ok) { ready = true; break; } } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, `${origin} readiness`);
    }
    const login = await fetch(`${admin}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json", Origin: admin }, body: JSON.stringify({ password: env.HTML_WORKBENCH_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    const session = await fetch(`${admin}/api/auth`, { headers: { Cookie: cookie } }).then((response) => response.json());
    const headers = { Cookie: cookie, Origin: admin, "X-CSRF-Token": session.csrfToken };
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
      const fixture = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Workflow</title><style>body{font:16px Arial;margin:24px}h1{font-size:28px}</style><script>window.workflowScript = true;</script></head><body><article data-business="preserve"><h1>Workflow sample</h1><p id="copy" contenteditable="false">Original content.</p></article></body></html>';
      const form = new FormData();
      form.set("file", new File([fixture], `workflow-${viewport.width}.html`, { type: "text/html" }));
      form.set("title", `Workflow ${viewport.width}`);
      form.set("documentType", "Other");
      const uploaded = await fetch(`${admin}/api/uploads`, { method: "POST", headers, body: form });
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const { record } = await uploaded.json();
      const context = await browser.newContext({ viewport });
      const split = cookie.indexOf("=");
      await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: admin, httpOnly: true, sameSite: "Strict" }]);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(admin);
      await page.locator(`a[data-action="edit"][href="/editor.html?id=${record.id}"]`).click();
      await page.waitForURL(`**/editor.html?id=${record.id}`);
      await page.locator("#loadState").waitFor({ state: "hidden" });
      const frame = page.frames().find((item) => item.parentFrame());
      assert.equal(await frame.evaluate(() => window.workflowScript), undefined);
      await frame.locator("#copy").dblclick();
      await frame.locator("#copy").fill(`Published ${viewport.width}.`);
      await page.locator("#saveButton").click();
      await page.waitForFunction(() => document.getElementById("message").textContent.includes("\u5df2\u4fdd\u5b58\u5e76\u53d1\u5e03"));
      const sourceResponse = await fetch(`${admin}/api/uploads/${record.id}/content`, { headers });
      const source = await sourceResponse.json();
      assert.ok(sourceResponse.headers.get("etag"));
      assert.ok(source.html.includes(`Published ${viewport.width}.`));
      assert.match(source.html, /<script>window.workflowScript = true;<\/script>/);
      assert.match(source.html, /data-business="preserve"/);
      assert.match(source.html, /contenteditable="false"/);
      assert.doesNotMatch(source.html, /data-hwb-editor/);
      assert.equal(source.record.url, record.url);
      const publicPage = await context.newPage();
      await publicPage.goto(record.url);
      assert.equal(await publicPage.locator("#copy").textContent(), `Published ${viewport.width}.`);
      assert.equal(await publicPage.evaluate(() => window.workflowScript), true);
      const screenshotDir = process.env.EDITOR_SCREENSHOT_DIR;
      if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: path.join(screenshotDir, `editor-workflow-${viewport.width}.png`), fullPage: true });
      }
      const rolledBack = await fetch(`${admin}/api/uploads/${record.id}`, { method: "PATCH", headers });
      assert.equal(rolledBack.status, 200, await rolledBack.clone().text());
      const restored = await fetch(`${admin}/api/uploads/${record.id}/content`, { headers }).then((response) => response.json());
      assert.equal(restored.html, fixture);
      await publicPage.reload();
      assert.equal(await publicPage.locator("#copy").textContent(), "Original content.");
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
