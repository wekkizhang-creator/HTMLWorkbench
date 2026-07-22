import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CHECK_SCRIPT = fileURLToPath(new URL("../scripts/check.mjs", import.meta.url));
const CHECKED_SOURCE_FILES = [
  "server.js",
  "public/app.js",
  "api/uploads.mjs",
  "api/delete-upload.mjs",
  "api/download.mjs",
  "api/auth.mjs",
  "api/view.mjs",
  "lib/auth.mjs",
  "lib/constants.mjs",
  "lib/http.mjs",
  "lib/records.mjs",
  "lib/storage.mjs",
  "lib/zip.mjs",
  "scripts/check.mjs"
];

function pngHeader(width, height, ihdrLength = 13) {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header, 0);
  header.writeUInt32BE(ihdrLength, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

async function runCheckWithLogo(logo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-check-"));
  try {
    for (const file of CHECKED_SOURCE_FILES) {
      const filePath = path.join(root, file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "export {};\n");
    }
    await fs.writeFile(path.join(root, "public", "brand-logo.png"), logo);
    return spawnSync(process.execPath, [CHECK_SCRIPT], {
      cwd: root,
      encoding: "utf8"
    });
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

test("brand logo check rejects a file without the PNG signature", async () => {
  const result = await runCheckWithLogo(Buffer.alloc(24));
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /PNG signature/i);
});

test("brand logo check rejects PNG dimensions other than 128x128", async () => {
  const result = await runCheckWithLogo(pngHeader(256, 128));
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /128x128/);
});

test("brand logo check rejects a malformed IHDR chunk", async () => {
  const result = await runCheckWithLogo(pngHeader(128, 128, 12));
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /IHDR/);
});

test("brand logo check accepts a 128x128 PNG header within the size limit", async () => {
  const result = await runCheckWithLogo(pngHeader(128, 128));
  assert.equal(result.status, 0, result.stderr);
});
