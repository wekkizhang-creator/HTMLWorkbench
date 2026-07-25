import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const TEST_RECORD_ID = "11111111-1111-4111-8111-111111111111";
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-csrf-"));
const previousEnvironment = new Map();
const environment = {
  HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
  HTML_WORKBENCH_AUTH_SECRET: "csrf-test-auth-secret",
  HTML_WORKBENCH_CURSOR_SECRET: "csrf-test-cursor-secret",
  HTML_WORKBENCH_DATA_DIR: dataDir,
  HTML_WORKBENCH_PASSWORD: "885688",
  HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
};

for (const [name, value] of Object.entries(environment)) {
  previousEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

await fs.mkdir(path.join(dataDir, "record-index-state"), { recursive: true });
await fs.writeFile(
  path.join(dataDir, "record-index-state", "v1-ready.json"),
  JSON.stringify({ version: 1, completedAt: new Date().toISOString() })
);

function importFresh(relativePath) {
  const fileUrl = pathToFileURL(path.resolve(path.dirname(import.meta.filename), relativePath));
  return import(`${fileUrl.href}?csrf=${Date.now()}-${Math.random()}`);
}

function cookieHeader(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

function uploadRequest({ cookie, csrfToken, origin = "https://ho.wekki.fun" } = {}) {
  const form = new FormData();
  form.set("file", new File(["<title>CSRF test</title>"], "csrf-test.html", { type: "text/html" }));
  form.set("documentType", "Other");
  const headers = { Cookie: cookie, Origin: origin };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return new Request("https://ho.wekki.fun/api/uploads", {
    body: form,
    headers,
    method: "POST"
  });
}

after(async () => {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(dataDir, { force: true, recursive: true });
});

test("authenticated management session exposes a bound CSRF token", async () => {
  const auth = await importFresh("../api/auth.mjs");
  const login = await auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    method: "POST"
  }));
  assert.equal(login.status, 200);
  const cookie = cookieHeader(login.headers.get("set-cookie"));
  const session = await auth.GET(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: cookie }
  }));
  const payload = await session.json();
  assert.equal(payload.authenticated, true);
  assert.match(payload.csrfToken, /^[A-Za-z0-9_-]{32,}$/);
});

test("public-origin CSRF with a valid cookie and token is rejected without storage side effects", async () => {
  const auth = await importFresh("../api/auth.mjs");
  const uploads = await importFresh("../api/uploads.mjs");
  const login = await auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    method: "POST"
  }));
  const cookie = cookieHeader(login.headers.get("set-cookie"));
  const session = await auth.GET(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: cookie }
  }));
  const { csrfToken } = await session.json();

  const response = await uploads.POST(uploadRequest({
    cookie,
    csrfToken,
    origin: "https://page.wekki.fun"
  }));
  assert.equal(response.status, 403);
  const recordsDir = path.join(dataDir, "records");
  assert.deepEqual(
    await fs.readdir(recordsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)),
    []
  );
});

test("same-origin management mutations require the session CSRF token", async () => {
  const auth = await importFresh("../api/auth.mjs");
  const deleteUpload = await importFresh("../api/delete-upload.mjs");
  const uploads = await importFresh("../api/uploads.mjs");
  const login = await auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    method: "POST"
  }));
  const cookie = cookieHeader(login.headers.get("set-cookie"));

  assert.equal((await uploads.POST(uploadRequest({ cookie }))).status, 403);
  assert.equal((await auth.DELETE(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: cookie, Origin: "https://ho.wekki.fun" },
    method: "DELETE"
  }))).status, 403);

  for (const [method, handler] of [
    ["DELETE", deleteUpload.DELETE],
    ["PUT", deleteUpload.PUT],
    ["PATCH", deleteUpload.PATCH]
  ]) {
    const response = await handler(new Request(
      `https://ho.wekki.fun/api/delete-upload?id=${TEST_RECORD_ID}`,
      {
        headers: { Cookie: cookie, Origin: "https://ho.wekki.fun" },
        method
      }
    ));
    assert.equal(response.status, 403, `${method} accepted a missing CSRF token`);
  }
});

test("trusted origin and bound token permit upload while login rejects public Origin", async () => {
  const auth = await importFresh("../api/auth.mjs");
  const uploads = await importFresh("../api/uploads.mjs");
  const rejectedLogin = await auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://page.wekki.fun"
    },
    method: "POST"
  }));
  assert.equal(rejectedLogin.status, 403);
  assert.equal(rejectedLogin.headers.get("set-cookie"), null);

  const login = await auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    method: "POST"
  }));
  const cookie = cookieHeader(login.headers.get("set-cookie"));
  const session = await auth.GET(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: cookie }
  }));
  const { csrfToken } = await session.json();
  const response = await uploads.POST(uploadRequest({ cookie, csrfToken }));
  assert.equal(response.status, 201);
});

test("management frontend sends the CSRF token on every authenticated write", async () => {
  const app = await fs.readFile("public/app.js", "utf8");
  assert.match(app, /csrfToken/);
  assert.match(app, /X-CSRF-Token/);
  assert.match(app, /xhr\.setRequestHeader\(["']X-CSRF-Token["']/);
  assert.match(app, /fetch\(["']\/api\/auth["'],\s*\{[^}]*method:\s*["']DELETE["'][^}]*headers:/s);
});

test("separate logins receive separate signed sessions and CSRF tokens", async () => {
  const auth = await importFresh("../api/auth.mjs");
  const login = () => auth.POST(new Request("https://ho.wekki.fun/api/auth", {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://ho.wekki.fun"
    },
    method: "POST"
  }));
  const firstCookie = cookieHeader((await login()).headers.get("set-cookie"));
  const secondCookie = cookieHeader((await login()).headers.get("set-cookie"));
  assert.notEqual(firstCookie, secondCookie);

  const firstSession = await auth.GET(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: firstCookie }
  }));
  const secondSession = await auth.GET(new Request("https://ho.wekki.fun/api/auth", {
    headers: { Cookie: secondCookie }
  }));
  const firstPayload = await firstSession.json();
  const secondPayload = await secondSession.json();
  assert.equal(firstPayload.authenticated, true);
  assert.equal(secondPayload.authenticated, true);
  assert.notEqual(firstPayload.csrfToken, secondPayload.csrfToken);
});
