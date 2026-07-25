import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ADMIN_ORIGIN = "https://ho.wekki.fun";
const PUBLIC_ORIGIN = "https://page.wekki.fun";
const STRONG_AUTH_SECRET = "oJPyDUkzBK7U78fZp1yJhMUJ8iL8dGeK6cX4HnJrT40";

function importFresh(relativePath) {
  const fileUrl = pathToFileURL(path.resolve(path.dirname(import.meta.filename), relativePath));
  return import(`${fileUrl.href}?task8a-review=${Date.now()}-${Math.random()}`);
}

async function withEnvironment(values, operation) {
  const names = new Set([
    "NODE_ENV",
    "VERCEL",
    "VERCEL_ENV",
    "BLOB_READ_WRITE_TOKEN",
    "HTML_WORKBENCH_ADMIN_ORIGIN",
    "HTML_WORKBENCH_PUBLIC_ORIGIN",
    "HTML_WORKBENCH_DATA_DIR",
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET",
    ...Object.keys(values)
  ]);
  const previous = new Map([...names].map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    HTML_WORKBENCH_ADMIN_ORIGIN: ADMIN_ORIGIN,
    HTML_WORKBENCH_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    HTML_WORKBENCH_PASSWORD: "885688",
    HTML_WORKBENCH_AUTH_SECRET: STRONG_AUTH_SECRET,
    HTML_WORKBENCH_DOWNLOAD_PASSWORD: "885688",
    HTML_WORKBENCH_CURSOR_SECRET: "Aq9R0nGCF82dXGfXQb2H7JmVZ5vY4gSaK9eLmP3d",
    ...overrides
  };
}

function cookieHeader(setCookie) {
  return String(setCookie || "").split(";", 1)[0];
}

async function login(auth) {
  return auth.POST(new Request(`${ADMIN_ORIGIN}/api/auth`, {
    body: JSON.stringify({ password: "885688" }),
    headers: {
      "Content-Type": "application/json",
      Origin: ADMIN_ORIGIN
    },
    method: "POST"
  }));
}

function createBlobSdk() {
  const blobs = new Map();
  const calls = { del: [], get: [], list: [], put: [] };
  return {
    blobs,
    calls,
    sdk: {
      async put(pathname, body, options) {
        calls.put.push({ pathname, options });
        blobs.set(pathname, String(body));
        return { pathname };
      },
      async get(pathname, options) {
        calls.get.push({ pathname, options });
        if (!blobs.has(pathname)) return null;
        return {
          statusCode: 200,
          stream: new Blob([blobs.get(pathname)]).stream()
        };
      },
      async list(options) {
        calls.list.push(options);
        const pathnames = [...blobs.keys()]
          .filter((pathname) => pathname.startsWith(options.prefix))
          .sort()
          .slice(0, options.limit);
        return {
          blobs: pathnames.map((pathname) => ({ pathname })),
          hasMore: false,
          cursor: undefined
        };
      },
      async del(pathnames) {
        const list = Array.isArray(pathnames) ? pathnames : [pathnames];
        calls.del.push([...list]);
        for (const pathname of list) blobs.delete(pathname);
      }
    }
  };
}

test("production auth refuses missing, placeholder, weak, or password-derived signing secrets", async () => {
  await withEnvironment(productionEnvironment(), async () => {
    const auth = await importFresh("../lib/auth.mjs");
    assert.equal(auth.verifyPassword("885688"), true);

    for (const secret of [
      undefined,
      "",
      "change-this-auth-secret",
      "<independent-high-entropy-random-secret-value>",
      "885688",
      "short-secret",
      "a".repeat(64)
    ]) {
      if (secret === undefined) delete process.env.HTML_WORKBENCH_AUTH_SECRET;
      else process.env.HTML_WORKBENCH_AUTH_SECRET = secret;
      assert.throws(
        () => auth.createAuthCookie({ secure: true }),
        /HTML_WORKBENCH_AUTH_SECRET/,
        `unsafe auth secret unexpectedly accepted: ${String(secret)}`
      );
    }

    process.env.HTML_WORKBENCH_AUTH_SECRET = STRONG_AUTH_SECRET;
    assert.match(auth.createAuthCookie({ secure: true }), /Secure/);
  });
});

test("Vercel profile and runtime fail closed unless all production variables are configured", async () => {
  const validate = await importFresh("../deploy/self-host/validate-env.mjs");
  const complete = productionEnvironment({
    VERCEL: "1",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  assert.equal(validate.validateEffectiveEnvironment(complete, { profile: "vercel" }), true);

  for (const name of [
    "HTML_WORKBENCH_ADMIN_ORIGIN",
    "HTML_WORKBENCH_PUBLIC_ORIGIN",
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET",
    "BLOB_READ_WRITE_TOKEN"
  ]) {
    const missing = { ...complete };
    delete missing[name];
    assert.throws(
      () => validate.validateEffectiveEnvironment(missing, { profile: "vercel" }),
      new RegExp(name)
    );
  }

  for (const name of [
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET",
    "BLOB_READ_WRITE_TOKEN"
  ]) {
    assert.throws(
      () => validate.validateEffectiveEnvironment(
        { ...complete, [name]: "<replace-with-production-value>" },
        { profile: "vercel" }
      ),
      new RegExp(name)
    );
  }

  await withEnvironment({ ...complete, HTML_WORKBENCH_AUTH_SECRET: undefined }, async () => {
    const runtime = await importFresh("../lib/runtime.mjs");
    assert.throws(() => runtime.getRuntimeConfig(), /HTML_WORKBENCH_AUTH_SECRET/);
  });
});

test("Vercel config and README document and enforce every required production variable", async () => {
  const config = JSON.parse(await fs.readFile("vercel.json", "utf8"));
  assert.match(config.buildCommand || "", /validate-env\.mjs --profile vercel/);

  const readme = await fs.readFile("README.md", "utf8");
  for (const name of [
    "HTML_WORKBENCH_ADMIN_ORIGIN",
    "HTML_WORKBENCH_PUBLIC_ORIGIN",
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET",
    "BLOB_READ_WRITE_TOKEN"
  ]) assert.match(readme, new RegExp(name));
  assert.match(readme, /AUTH_SECRET.{0,120}(?:32|random|随机)/is);
});

test("logout persists revocation so a reloaded server rejects the old cookie and CSRF token", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-revocation-"));
  try {
    await fs.mkdir(path.join(dataDir, "record-index-state"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "record-index-state", "v1-ready.json"),
      JSON.stringify({ version: 1, completedAt: new Date().toISOString() })
    );
    await withEnvironment({
      HTML_WORKBENCH_ADMIN_ORIGIN: ADMIN_ORIGIN,
      HTML_WORKBENCH_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      HTML_WORKBENCH_DATA_DIR: dataDir,
      HTML_WORKBENCH_PASSWORD: "885688",
      HTML_WORKBENCH_AUTH_SECRET: STRONG_AUTH_SECRET,
      HTML_WORKBENCH_DOWNLOAD_PASSWORD: "885688",
      HTML_WORKBENCH_CURSOR_SECRET: "task8a-local-cursor-secret"
    }, async () => {
      const auth = await importFresh("../api/auth.mjs");
      const loginResponse = await login(auth);
      const cookie = cookieHeader(loginResponse.headers.get("set-cookie"));
      const sessionResponse = await auth.GET(new Request(`${ADMIN_ORIGIN}/api/auth`, {
        headers: { Cookie: cookie }
      }));
      const { csrfToken } = await sessionResponse.json();

      const logout = await auth.DELETE(new Request(`${ADMIN_ORIGIN}/api/auth`, {
        headers: {
          Cookie: cookie,
          Origin: ADMIN_ORIGIN,
          "X-CSRF-Token": csrfToken
        },
        method: "DELETE"
      }));
      assert.equal(logout.status, 200);

      const reloadedAuth = await importFresh("../api/auth.mjs");
      const reloadedUploads = await importFresh("../api/uploads.mjs");
      const oldSession = await reloadedAuth.GET(new Request(`${ADMIN_ORIGIN}/api/auth`, {
        headers: { Cookie: cookie }
      }));
      assert.deepEqual(await oldSession.json(), { authenticated: false, csrfToken: null });

      const form = new FormData();
      form.set("file", new File(["<title>revoked</title>"], "revoked.html", { type: "text/html" }));
      form.set("documentType", "Other");
      const replay = await reloadedUploads.POST(new Request(`${ADMIN_ORIGIN}/api/uploads`, {
        body: form,
        headers: {
          Cookie: cookie,
          Origin: ADMIN_ORIGIN,
          "X-CSRF-Token": csrfToken
        },
        method: "POST"
      }));
      assert.equal(replay.status, 401);
      assert.equal(await fs.readdir(path.join(dataDir, "records")).then((items) => items.length).catch(() => 0), 0);
    });
  } finally {
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});

test("Blob revocation is durable, idempotent, cache-bypassed, and cleans only expired tombstones", async () => {
  const revocations = await importFresh("../lib/session-revocation.mjs");
  const fake = createBlobSdk();
  const nowMs = Date.UTC(2026, 6, 25, 12, 0, 0);
  const expired = { token: "expired-session-token", expiresAtMs: nowMs - 1 };
  const active = { token: "active-session-token", expiresAtMs: nowMs + 60_000 };

  await Promise.all([
    revocations.revokeSession(active, { blobSdk: fake.sdk }),
    revocations.revokeSession(active, { blobSdk: fake.sdk })
  ]);
  assert.equal(await revocations.isSessionRevoked(active, { blobSdk: fake.sdk }), true);
  assert.equal(fake.calls.put.length, 2);
  const missingStoreSdk = {
    ...fake.sdk,
    async get() {
      const error = new Error("Blob store not found");
      error.name = "BlobStoreNotFoundError";
      error.status = 404;
      throw error;
    }
  };
  await assert.rejects(
    revocations.isSessionRevoked(active, { blobSdk: missingStoreSdk }),
    /Blob store not found/
  );

  assert.equal(fake.calls.put[0].pathname, fake.calls.put[1].pathname);
  assert.equal(fake.calls.put[0].options.allowOverwrite, true);
  assert.equal(fake.calls.get.at(-1).options.useCache, false);

  await revocations.revokeSession(expired, { blobSdk: fake.sdk });
  await Promise.all([
    revocations.cleanupExpiredSessionRevocations({ blobSdk: fake.sdk, nowMs, maxDeletes: 100 }),
    revocations.revokeSession(active, { blobSdk: fake.sdk })
  ]);

  const paths = [...fake.blobs.keys()];
  assert.equal(paths.some((pathname) => pathname.includes("expired")), false);
  assert.equal(paths.includes(revocations.buildSessionRevocationPath(active)), true);
  assert.equal(paths.includes(revocations.buildSessionRevocationPath(expired)), false);
});

test("session validity ends at the same instant revocation tombstones become cleanable", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-expiry-"));
  const originalNow = Date.now;
  const issuedAtMs = Date.UTC(2026, 6, 25, 12, 0, 0);
  const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
  try {
    await withEnvironment({
      HTML_WORKBENCH_DATA_DIR: dataDir,
      HTML_WORKBENCH_PASSWORD: "885688",
      HTML_WORKBENCH_AUTH_SECRET: STRONG_AUTH_SECRET
    }, async () => {
      const auth = await importFresh("../lib/auth.mjs");
      Date.now = () => issuedAtMs;
      const cookie = cookieHeader(auth.createAuthCookie());

      Date.now = () => issuedAtMs + sessionLifetimeMs - 1;
      assert.equal(await auth.isAuthorizedCookie(cookie), true);

      Date.now = () => issuedAtMs + sessionLifetimeMs;
      assert.equal(await auth.isAuthorizedCookie(cookie), false);
    });
  } finally {
    Date.now = originalNow;
    await fs.rm(dataDir, { force: true, recursive: true });
  }
});
