export const PRODUCTION_ADMIN_ORIGIN = "https://desk.wekkii.cn";
export const PRODUCTION_PUBLIC_ORIGIN = "https://ho.wekkii.cn";
export const LEGACY_ADMIN_ORIGIN = "https://ho.wekki.fun";
export const LEGACY_PUBLIC_ORIGIN = "https://page.wekki.fun";

export const MANAGEMENT_CREDENTIAL_NAMES = Object.freeze([
  "HTML_WORKBENCH_PASSWORD",
  "HTML_WORKBENCH_AUTH_SECRET",
  "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
  "HTML_WORKBENCH_CURSOR_SECRET"
]);

function credentialError(name, detail = "must be a non-empty production credential") {
  return new Error(`${name} ${detail}`);
}

function isPlaceholderCredential(value) {
  const normalized = value.trim();
  return /^change-this(?:-|$)/i.test(normalized)
    || /^<[^>]+>$/.test(normalized)
    || /^(?:placeholder|replace-me|your-(?:secret|token|password)(?:-here)?)$/i.test(normalized);
}

export function isProtectedRuntime(environment = process.env) {
  return environment.NODE_ENV === "production"
    || environment.VERCEL === "1"
    || ["production", "preview"].includes(environment.VERCEL_ENV);
}

export function requireProductionCredential(environment, name) {
  const value = environment[name];
  if (
    typeof value !== "string"
    || value.trim() === ""
    || isPlaceholderCredential(value)
  ) {
    throw credentialError(name);
  }
  return value;
}

export function requireStrongAuthSecret(environment) {
  const secret = requireProductionCredential(environment, "HTML_WORKBENCH_AUTH_SECRET");
  const password = requireProductionCredential(environment, "HTML_WORKBENCH_PASSWORD");
  if (secret === password) {
    throw credentialError("HTML_WORKBENCH_AUTH_SECRET", "must be independent from HTML_WORKBENCH_PASSWORD");
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw credentialError("HTML_WORKBENCH_AUTH_SECRET", "must contain at least 32 bytes of random material");
  }
  if (new Set(secret).size < 12) {
    throw credentialError("HTML_WORKBENCH_AUTH_SECRET", "must contain high-entropy random material");
  }
  return secret;
}

export function validateAdminCredentials(environment, { requireBlob = false } = {}) {
  for (const name of MANAGEMENT_CREDENTIAL_NAMES) {
    requireProductionCredential(environment, name);
  }
  requireStrongAuthSecret(environment);
  if (requireBlob) requireProductionCredential(environment, "BLOB_READ_WRITE_TOKEN");
  return true;
}

export function validateProductionOrigins(environment) {
  if (environment.HTML_WORKBENCH_ADMIN_ORIGIN !== PRODUCTION_ADMIN_ORIGIN) {
    throw new Error(`HTML_WORKBENCH_ADMIN_ORIGIN must be exactly ${PRODUCTION_ADMIN_ORIGIN}`);
  }
  if (environment.HTML_WORKBENCH_PUBLIC_ORIGIN !== PRODUCTION_PUBLIC_ORIGIN) {
    throw new Error(`HTML_WORKBENCH_PUBLIC_ORIGIN must be exactly ${PRODUCTION_PUBLIC_ORIGIN}`);
  }
  for (const [name, expected] of [["HTML_WORKBENCH_LEGACY_ADMIN_ORIGIN", LEGACY_ADMIN_ORIGIN], ["HTML_WORKBENCH_LEGACY_PUBLIC_ORIGIN", LEGACY_PUBLIC_ORIGIN]]) {
    if (environment[name] !== undefined && environment[name] !== expected) {
      throw new Error(`${name} must be exactly ${expected}`);
    }
  }
  return true;
}

export function validateAdminRuntimeEnvironment(environment = process.env) {
  validateProductionOrigins(environment);
  validateAdminCredentials(environment, { requireBlob: environment.VERCEL === "1" });
  return true;
}

export function validateContentRuntimeEnvironment(environment = process.env) {
  validateProductionOrigins(environment);
  for (const name of MANAGEMENT_CREDENTIAL_NAMES) {
    if (environment[name] !== undefined) {
      throw new Error(`Content runtime must not receive ${name}`);
    }
  }
  return true;
}
