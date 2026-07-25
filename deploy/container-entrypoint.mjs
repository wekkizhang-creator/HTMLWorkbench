import { spawn } from "node:child_process";
import os from "node:os";

import { validateEffectiveEnvironment } from "./self-host/validate-env.mjs";

try {
  validateEffectiveEnvironment(process.env, { profile: "container" });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(78);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write("Container command is required.\n");
  process.exit(64);
}

const child = spawn(command, args, { env: process.env, stdio: "inherit" });
const forwardedSignals = ["SIGINT", "SIGTERM"];
const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};

for (const signal of forwardedSignals) {
  process.on(signal, () => forwardSignal(signal));
}

child.on("error", (error) => {
  process.stderr.write(`Unable to start container command: ${error.message}\n`);
  process.exitCode = 126;
});

child.on("exit", (code, signal) => {
  for (const forwardedSignal of forwardedSignals) process.removeAllListeners(forwardedSignal);
  process.exitCode = code ?? 128 + (os.constants.signals[signal] ?? 1);
});