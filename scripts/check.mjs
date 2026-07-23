import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const files = [
  "server.js",
  "public/app.js",
  "api/uploads.mjs",
  "api/delete-upload.mjs",
  "api/download.mjs",
  "api/auth.mjs",
  "api/view.mjs",
  "api/health.mjs",
  "lib/auth.mjs",
  "lib/constants.mjs",
  "lib/http.mjs",
  "lib/records.mjs",
  "lib/storage.mjs",
  "lib/zip.mjs",
  "scripts/check.mjs"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

const MAX_BRAND_LOGO_BYTES = 60 * 1024;
const BRAND_LOGO_PATH = "public/brand-logo.png";
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const logoSize = statSync(BRAND_LOGO_PATH).size;
if (logoSize > MAX_BRAND_LOGO_BYTES) {
  console.error(`${BRAND_LOGO_PATH} is ${logoSize} bytes; limit is ${MAX_BRAND_LOGO_BYTES}`);
  process.exit(1);
}

const logo = readFileSync(BRAND_LOGO_PATH);
if (logo.length < 24 || !logo.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
  console.error(`${BRAND_LOGO_PATH} must have a valid PNG signature`);
  process.exit(1);
}
if (logo.readUInt32BE(8) !== 13 || logo.toString("ascii", 12, 16) !== "IHDR") {
  console.error(`${BRAND_LOGO_PATH} must start with a PNG IHDR chunk`);
  process.exit(1);
}

const logoWidth = logo.readUInt32BE(16);
const logoHeight = logo.readUInt32BE(20);
if (logoWidth !== 128 || logoHeight !== 128) {
  console.error(`${BRAND_LOGO_PATH} must be 128x128; received ${logoWidth}x${logoHeight}`);
  process.exit(1);
}
