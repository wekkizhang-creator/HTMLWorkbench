import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function reservePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function withServer(run, { args = ["server.js"], startupTimeoutMs = 5000 } = {}) {
  const port = await reservePort();
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTML_WORKBENCH_DATA_DIR: `${process.cwd()}/data-test`,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server startup timed out")), startupTimeoutMs);
      child.once("exit", (code) => reject(new Error(`server exited with code ${code}`)));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (chunk.includes("已启动")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await run(`http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }
  }
}

function request(origin, pathname, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${pathname}`, { headers, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks),
        headers: res.headers,
        status: res.statusCode
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("withServer stops a child when startup times out", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-test-"));
  const pidFile = path.join(tempDir, "child.pid");
  const childScript = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;

  try {
    await assert.rejects(
      withServer(async () => {}, {
        args: ["-e", childScript],
        startupTimeoutMs: 100
      }),
      /server startup timed out/
    );

    const pid = Number(await fs.readFile(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
});

test("Accept-Encoding quality values select a supported representation", async () => {
  await withServer(async (origin) => {
    const gzip = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "gzip;q=1" }
    });
    assert.equal(gzip.status, 200);
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.ok(gzip.body.length > 0);

    const identity = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "gzip;q=0, identity;q=1" }
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.notEqual(identity.headers.etag, gzip.headers.etag);

    const wildcard = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "*" }
    });
    assert.equal(wildcard.headers["content-encoding"], "gzip");

    const identityPreferred = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "gzip;q=0.3, identity;q=0.8" }
    });
    assert.equal(identityPreferred.headers["content-encoding"], undefined);

    const wildcardPreferred = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "br;q=1, *;q=0.8, identity;q=0.2" }
    });
    assert.equal(wildcardPreferred.headers["content-encoding"], "gzip");

    const defaultIdentity = await request(origin, "/styles.css");
    assert.equal(defaultIdentity.status, 200);
    assert.equal(defaultIdentity.headers["content-encoding"], undefined);

    const wildcardExcluded = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "*;q=0" }
    });
    assert.equal(wildcardExcluded.status, 406);

    const explicitIdentity = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "*;q=0, identity;q=1" }
    });
    assert.equal(explicitIdentity.status, 200);
    assert.equal(explicitIdentity.headers["content-encoding"], undefined);

    const unacceptable = await request(origin, "/styles.css", {
      headers: { "Accept-Encoding": "gzip;q=0, identity;q=0, *;q=0" }
    });
    assert.equal(unacceptable.status, 406);
    assert.equal(unacceptable.body.length, 0);
    assert.equal(unacceptable.headers.vary, "Accept-Encoding");
  });
});

test("conditional requests use weak matching and variant-specific validators", async () => {
  await withServer(async (origin) => {
    const gzip = await request(origin, "/app.js", {
      headers: { "Accept-Encoding": "gzip" }
    });
    const gzipEtag = gzip.headers.etag;
    assert.ok(gzipEtag);

    const weak = await request(origin, "/app.js", {
      headers: {
        "Accept-Encoding": "gzip",
        "If-None-Match": `W/${gzipEtag}`
      }
    });
    assert.equal(weak.status, 304);
    assert.equal(weak.headers.etag, gzipEtag);
    assert.equal(weak.headers["content-encoding"], "gzip");
    assert.equal(weak.headers.vary, "Accept-Encoding");
    assert.equal(weak.body.length, 0);

    const listed = await request(origin, "/app.js", {
      headers: {
        "Accept-Encoding": "gzip",
        "If-None-Match": `"not-this-one", W/${gzipEtag}`
      }
    });
    assert.equal(listed.status, 304);

    const starredHead = await request(origin, "/app.js", {
      method: "HEAD",
      headers: {
        "Accept-Encoding": "gzip",
        "If-None-Match": "*"
      }
    });
    assert.equal(starredHead.status, 304);
    assert.equal(starredHead.headers["content-encoding"], "gzip");
    assert.equal(starredHead.body.length, 0);

    const identity = await request(origin, "/app.js", {
      headers: {
        "Accept-Encoding": "identity",
        "If-None-Match": gzipEtag
      }
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.notEqual(identity.headers.etag, gzipEtag);
  });
});

test("HEAD returns selected static headers without a response body", async () => {
  await withServer(async (origin) => {
    const response = await request(origin, "/app.js", {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip;q=1" }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-encoding"], "gzip");
    assert.ok(response.headers.etag);
    assert.ok(Number(response.headers["content-length"]) > 0);
    assert.equal(response.body.length, 0);
  });
});

test("PinShot static assets are publicly served with cache validators and complete syntax coverage", async () => {
  const checkScript = await fs.readFile("scripts/check.mjs", "utf8");
  const pinshotFiles = [
    "public/pinshot/app.mjs",
    "public/pinshot/state.mjs",
    "public/pinshot/geometry.mjs",
    "public/pinshot/capture.mjs",
    "public/pinshot/annotations.mjs",
    "public/pinshot/canvas.mjs",
    "public/pinshot/scene.mjs",
    "public/pinshot/output.mjs",
    "public/pinshot/pins.mjs",
    "public/pinshot/settings.mjs",
    "public/pinshot/settings-view.mjs",
    "public/pinshot/keyboard.mjs"
  ];
  for (const file of pinshotFiles) {
    assert.match(checkScript, new RegExp(`"${file.replaceAll(".", "\\.")}"`));
  }

  await withServer(async (origin) => {
    const page = await request(origin, "/pinshot.html");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"], /^text\/html; charset=utf-8$/);
    assert.match(page.body.toString("utf8"), /id="pinshotApp"/);
    assert.match(page.body.toString("utf8"), /\u8fd9\u662f\u4ea4\u4e92\u539f\u578b\uff0c\u4e0d\u4f1a\u8bfb\u53d6\u771f\u5b9e\u7cfb\u7edf\u5c4f\u5e55/);
    assert.ok(page.headers.etag);

    const staticAssets = [
      ["/pinshot/styles.css", "text/css; charset=utf-8"],
      ...pinshotFiles.map((file) => [`/${file.replace(/^public\//, "")}`, "text/javascript; charset=utf-8"])
    ];
    for (const [pathname, contentType] of staticAssets) {
      const response = await request(origin, pathname);
      assert.equal(response.status, 200, `${pathname} GET status`);
      assert.equal(response.headers["content-type"], contentType, `${pathname} GET content type`);
      assert.ok(response.headers.etag, `${pathname} GET ETag`);
      assert.ok(response.body.length > 0, `${pathname} GET body`);

      const head = await request(origin, pathname, { method: "HEAD" });
      assert.equal(head.status, 200, `${pathname} HEAD status`);
      assert.equal(head.headers["content-type"], contentType, `${pathname} HEAD content type`);
      assert.equal(head.headers.etag, response.headers.etag, `${pathname} HEAD ETag`);
      assert.ok(Number(head.headers["content-length"]) > 0, `${pathname} HEAD content length`);
      assert.equal(head.body.length, 0, `${pathname} HEAD body`);
    }
  });
});

test("PinShot shell uses valid markup and honors reduced motion", async () => {
  await withServer(async (origin) => {
    const page = await request(origin, "/pinshot.html");
    assert.equal(page.status, 200);
    const pageBody = page.body.toString("utf8");
    assert.match(pageBody, /<title>PinShot \u622a\u8d34 \u00b7 PC \u622a\u56fe\u5de5\u5177\u539f\u578b<\/title>/);
    assert.doesNotMatch(pageBody, /\?\/[a-z]/i);

    const styles = await request(origin, "/pinshot/styles.css");
    assert.equal(styles.status, 200);
    assert.equal(styles.headers["content-type"], "text/css; charset=utf-8");
    assert.match(
      styles.body.toString("utf8"),
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.toast\s*\{\s*transition:\s*none;\s*}/
    );
  });
});
