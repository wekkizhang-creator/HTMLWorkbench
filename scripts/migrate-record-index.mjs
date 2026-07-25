import {
  migrateRecordIndex,
  recoverRecordIndexMaintenance
} from "../lib/storage.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const recoverLock = args.includes("--recover-lock");

try {
  if (recoverLock) {
    const recovery = await recoverRecordIndexMaintenance();
    console.log(JSON.stringify(recovery, null, 2));
  } else {
    const summary = await migrateRecordIndex({ dryRun });
    console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
    if (summary.failed > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
