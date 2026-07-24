import { migrateRecordIndex } from "../lib/storage.mjs";

const dryRun = process.argv.slice(2).includes("--dry-run");

try {
  const summary = await migrateRecordIndex({ dryRun });
  console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
