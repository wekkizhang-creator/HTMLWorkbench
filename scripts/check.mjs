import { spawnSync } from "node:child_process";

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
