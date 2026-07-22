import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const files = [
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

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

const MAX_BRAND_LOGO_BYTES = 60 * 1024;
const logoSize = statSync("public/brand-logo.png").size;
if (logoSize > MAX_BRAND_LOGO_BYTES) {
  console.error(`public/brand-logo.png is ${logoSize} bytes; limit is ${MAX_BRAND_LOGO_BYTES}`);
  process.exit(1);
}
