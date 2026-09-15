import {
  LEGACY_ADMIN_ORIGIN,
  LEGACY_PUBLIC_ORIGIN,
  isProtectedRuntime,
  validateAdminRuntimeEnvironment,
  validateContentRuntimeEnvironment
} from "./security-config.mjs";
import { PUBLIC_VIEW_RE, publicViewPath } from "./public-links.mjs";
export { PUBLIC_VIEW_RE };

const VALID_ROLES = new Set(["admin", "content"]);

function normalizeOrigin(value) {
  return new URL(value).origin;
}

export function getRuntimeConfig() {
  const role = process.env.HTML_WORKBENCH_ROLE || "admin";
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Unsupported HTML_WORKBENCH_ROLE: ${role}`);
  }
  const protectedRuntime = isProtectedRuntime();
  if (protectedRuntime) {
    if (role === "content") validateContentRuntimeEnvironment();
    else validateAdminRuntimeEnvironment();
  }

  const adminOrigin = normalizeOrigin(process.env.HTML_WORKBENCH_ADMIN_ORIGIN || "http://localhost:3000");
  const publicOrigin = normalizeOrigin(process.env.HTML_WORKBENCH_PUBLIC_ORIGIN || "http://localhost:3001");
  return {
    role,
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || (role === "content" ? 3001 : 3000)),
    adminOrigin,
    publicOrigin,
    legacyAdminOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_LEGACY_ADMIN_ORIGIN || (protectedRuntime ? LEGACY_ADMIN_ORIGIN : adminOrigin)),
    legacyPublicOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_LEGACY_PUBLIC_ORIGIN || (protectedRuntime ? LEGACY_PUBLIC_ORIGIN : publicOrigin))
  };
}

export function buildPublicViewUrl(record) {
  const config = getRuntimeConfig();
  return new URL(record.url || publicViewPath(record), record.publicOrigin || config.legacyPublicOrigin).href;
}

export function isPublicHost(host) {
  const { publicOrigin, legacyPublicOrigin } = getRuntimeConfig();
  return [publicOrigin, legacyPublicOrigin].some(origin => new URL(origin).host.toLowerCase() === String(host || "").toLowerCase());
}

export function isAllowedHost(host, role) {
  const config = getRuntimeConfig();
  if (role === "content") return isPublicHost(host);
  return [config.adminOrigin, config.legacyAdminOrigin].some(origin => new URL(origin).host.toLowerCase() === String(host || "").toLowerCase());
}

export function isRouteAllowed(role, pathname) {
  if (role === "content") {
    return pathname === "/healthz" || PUBLIC_VIEW_RE.test(pathname);
  }
  return true;
}

export function getVercelHostDecision(requestUrl, method = "GET") {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const { adminOrigin, publicOrigin, legacyAdminOrigin, legacyPublicOrigin } = getRuntimeConfig();
  const requestHost = url.host.toLowerCase();
  const adminHost = new URL(adminOrigin).host.toLowerCase();
  if (isPublicHost(requestHost)) {
    return { action: isRouteAllowed("content", url.pathname) ? "next" : "not-found" };
  }

  const isLegacyAdmin = requestHost !== adminHost && requestHost === new URL(legacyAdminOrigin).host.toLowerCase();
  if (requestHost === adminHost || isLegacyAdmin) {
    const view = url.pathname.match(PUBLIC_VIEW_RE);
    if (view || isLegacyAdmin) {
      if (!["GET", "HEAD"].includes(method)) return { action: "not-found" };
      const targetOrigin = view ? (view[1].length === 36 ? legacyPublicOrigin : publicOrigin) : adminOrigin;
      // Assign path/query separately so a //path cannot replace the trusted host.
      const destination = new URL(targetOrigin);
      destination.pathname = url.pathname;
      destination.search = url.search;
      return { action: "redirect", location: destination.href };
    }
    return { action: "next" };
  }

  return { action: "misdirected" };
}
