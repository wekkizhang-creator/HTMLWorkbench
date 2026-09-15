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
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://desk.wekkii.cn",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://ho.wekkii.cn"
  }),
  container: Object.freeze({
    HTML_WORKBENCH_DATA_DIR: "/data",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://desk.wekkii.cn",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://ho.wekkii.cn"
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

export { parseSystemdEnvironmentFile } from "./environment-file.mjs";

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
