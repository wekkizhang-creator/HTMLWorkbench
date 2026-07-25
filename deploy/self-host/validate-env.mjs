import { fileURLToPath } from "node:url";

import {
  MANAGEMENT_CREDENTIAL_NAMES,
  PRODUCTION_ADMIN_ORIGIN,
  PRODUCTION_PUBLIC_ORIGIN,
  validateAdminCredentials
} from "../../lib/security-config.mjs";

const REQUIRED_VALUES = Object.freeze({
  host: Object.freeze({
    HTML_WORKBENCH_DATA_DIR: "/var/lib/html-workbench",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  }),
  container: Object.freeze({
    HTML_WORKBENCH_DATA_DIR: "/data",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  })
});

const PROFILE_CONFIG = Object.freeze({
  host: Object.freeze({ values: REQUIRED_VALUES.host, requireSecrets: true, requireBlob: false, forbidSecrets: false }),
  container: Object.freeze({ values: REQUIRED_VALUES.container, requireSecrets: true, requireBlob: false, forbidSecrets: false }),
  "content-host": Object.freeze({ values: REQUIRED_VALUES.host, requireSecrets: false, requireBlob: false, forbidSecrets: true }),
  "content-container": Object.freeze({ values: REQUIRED_VALUES.container, requireSecrets: false, requireBlob: false, forbidSecrets: true }),
  vercel: Object.freeze({
    values: Object.freeze({
      HTML_WORKBENCH_ADMIN_ORIGIN: PRODUCTION_ADMIN_ORIGIN,
      HTML_WORKBENCH_PUBLIC_ORIGIN: PRODUCTION_PUBLIC_ORIGIN
    }),
    requireSecrets: true,
    requireBlob: true,
    forbidSecrets: false
  })
});

function parseValue(raw, lineNumber) {
  let value = "";
  let index = 0;
  let quote = null;
  while (index < raw.length) {
    const character = raw[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else value += character;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === "\\" && index + 1 < raw.length) {
        index += 1;
        value += raw[index];
      } else {
        value += character;
      }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "\\" && index + 1 < raw.length) {
      index += 1;
      value += raw[index];
    } else if (character === "#" && (index === 0 || /\s/.test(raw[index - 1]))) {
      break;
    } else {
      value += character;
    }
    index += 1;
  }
  if (quote) throw new Error(`Unterminated quote on environment line ${lineNumber}`);
  return value.trimEnd();
}

export function parseSystemdEnvironmentFile(contents) {
  const environment = {};
  const logicalLines = [];
  let pending = "";
  for (const physicalLine of String(contents).split(/\r?\n/)) {
    pending += physicalLine;
    let slashCount = 0;
    for (let index = pending.length - 1; index >= 0 && pending[index] === "\\"; index -= 1) slashCount += 1;
    if (slashCount % 2 === 1) {
      pending = pending.slice(0, -1);
      continue;
    }
    logicalLines.push(pending);
    pending = "";
  }
  if (pending) logicalLines.push(pending);

  for (const [index, line] of logicalLines.entries()) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`Invalid environment assignment on line ${index + 1}`);
    environment[match[1]] = parseValue(match[2], index + 1);
  }
  return environment;
}

export function validateEffectiveEnvironment(environment = process.env, { profile = "host" } = {}) {
  const profileConfig = PROFILE_CONFIG[profile];
  if (!profileConfig) throw new Error(`Unknown production environment profile: ${profile}`);
  for (const [name, expected] of Object.entries(profileConfig.values)) {
    if (environment[name] !== expected) {
      throw new Error(`${name} must be exactly ${expected}`);
    }
  }
  if (profileConfig.requireSecrets) {
    validateAdminCredentials(environment, { requireBlob: profileConfig.requireBlob });
  }
  if (profileConfig.forbidSecrets) {
    for (const name of MANAGEMENT_CREDENTIAL_NAMES) {
      if (environment[name] !== undefined) {
        throw new Error(`Content profile must not receive ${name}`);
      }
    }
  }
  return true;
}

function requestedProfile(args) {
  const profileIndex = args.indexOf("--profile");
  if (profileIndex === -1) return "host";
  if (!args[profileIndex + 1]) throw new Error("--profile requires a value");
  return args[profileIndex + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    validateEffectiveEnvironment(process.env, { profile: requestedProfile(process.argv.slice(2)) });
    process.stdout.write("Effective HTMLWorkbench environment is valid.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
