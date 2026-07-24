import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const TEST_RECORD_ID = "11111111-1111-4111-8111-111111111111";

async function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function importFresh(relativePath) {
  const fileUrl = pathToFileURL(path.resolve(path.dirname(import.meta.filename), relativePath));
  return import(`${fileUrl.href}?${Date.now()}-${Math.random()}`);
}

async function withRecord(run) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-download-"));
  await fs.mkdir(path.join(dataDir, "records"));
  await fs.mkdir(path.join(dataDir, "uploads"));
  await fs.writeFile(path.join(dataDir, "records", `${TEST_RECORD_ID}.json`), JSON.stringify({
    id: TEST_RECORD_ID,
    originalName: "test.html",
    title: "Test",
    uploadKind: "html",
    blobPath: `uploads/${TEST_RECORD_ID}.html`
  }));
  await fs.writeFile(path.join(dataDir, "uploads", `${TEST_RECORD_ID}.html`), "<main>untrusted content</main>");

  try {
    await withEnv({
      HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
      HTML_WORKBENCH_DATA_DIR: dataDir,
      HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
    }, run);
  } finally {
    await fs.rm(dataDir, { force: true, recursive: true });
  }
}

test("view HTML contains an admin-origin iframe and no password input", async () => {
  await withRecord(async () => {
    const { GET: viewGet } = await importFresh("../api/view.mjs");
    const response = await viewGet(new Request(`https://page.wekki.fun/view/${TEST_RECORD_ID}?id=${TEST_RECORD_ID}`));
    const html = await response.text();
    assert.match(html, /https:\/\/ho\.wekki\.fun\/public-download-widget\//);
    assert.match(html, /sandbox="allow-forms allow-scripts allow-downloads allow-same-origin"/);
    assert.doesNotMatch(html, /html-workbench-download-password/);
    assert.doesNotMatch(html, /html-workbench-download-panel/);
  });
});

test("download uses a dedicated password", async () => {
  await withEnv({
    HTML_WORKBENCH_PASSWORD: "admin-secret",
    HTML_WORKBENCH_DOWNLOAD_PASSWORD: "885688"
  }, async () => {
    const { verifyDownloadPassword } = await importFresh("../lib/auth.mjs");
    assert.equal(verifyDownloadPassword("admin-secret"), false);
    assert.equal(verifyDownloadPassword("885688"), true);
  });
});

test("download rejects a public-origin request before reading storage", async () => {
  await withEnv({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  }, async () => {
    const { POST, isTrustedAdminOrigin } = await importFresh("../api/download.mjs");
    const request = new Request(`https://ho.wekki.fun/api/download?id=${TEST_RECORD_ID}`, {
      body: JSON.stringify({ password: "885688" }),
      headers: { "Content-Type": "application/json", Origin: "https://page.wekki.fun" },
      method: "POST"
    });
    assert.equal(isTrustedAdminOrigin(request), false);
    assert.equal((await POST(request)).status, 403);
  });
});

test("trusted widget permits only the configured public ancestor", async () => {
  await withEnv({
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  }, async () => {
    const { GET } = await importFresh("../api/download-widget.mjs");
    const response = await GET(new Request(`https://ho.wekki.fun/public-download-widget/${TEST_RECORD_ID}`));
    const html = await response.text();
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors https://page.wekki.fun");
    assert.match(html, /html-workbench-download-password/);
    assert.match(html, /https:\/\/ho\.wekki\.fun\/api\/download/);
  });
});

test("production auth cookies are host-only, secure, strict, and http-only", async () => {
  const { createAuthCookie } = await importFresh("../lib/auth.mjs");
  const cookie = createAuthCookie({ secure: true });
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Domain=/);
});
