import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import test from "node:test";

import * as storage from "../lib/storage.mjs";

test("Blob readiness executes its authenticated read-only probe", async () => {
  assert.equal(typeof storage.checkBlobReadiness, "function");
  let calls = 0;
  await storage.checkBlobReadiness(async () => { calls += 1; return { blobs: [] }; }, 100);
  assert.equal(calls, 1);
});

test("Blob readiness surfaces authentication or network failures", async () => {
  await assert.rejects(
    storage.checkBlobReadiness(async () => { throw new Error("invalid token"); }, 100),
    /invalid token/
  );
});

test("Blob readiness is time bounded", async () => {
  await assert.rejects(
    storage.checkBlobReadiness(() => new Promise(() => {}), 10),
    /timed out/i
  );
});

test("content readiness requires reads only while admin readiness requires reads and writes", () => {
  assert.equal(storage.getLocalReadinessAccessMode({ writable: false }), fsConstants.R_OK);
  assert.equal(
    storage.getLocalReadinessAccessMode({ writable: true }),
    fsConstants.R_OK | fsConstants.W_OK
  );
});
