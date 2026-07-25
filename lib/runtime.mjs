const VALID_ROLES = new Set(["admin", "content"]);

function normalizeOrigin(value) {
  return new URL(value).origin;
}

export function getRuntimeConfig() {
  const role = process.env.HTML_WORKBENCH_ROLE || "admin";
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Unsupported HTML_WORKBENCH_ROLE: ${role}`);
  }

  return {
    role,
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || (role === "content" ? 3001 : 3000)),
    adminOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_ADMIN_ORIGIN || "http://localhost:3000"),
    publicOrigin: normalizeOrigin(process.env.HTML_WORKBENCH_PUBLIC_ORIGIN || "http://localhost:3001")
  };
}

export function buildPublicViewUrl(record) {
  return new URL(record.url || `/view/${record.id}`, getRuntimeConfig().publicOrigin).href;
}

export function isAllowedHost(host, role) {
  const config = getRuntimeConfig();
  const expectedOrigin = role === "content" ? config.publicOrigin : config.adminOrigin;
  return String(host || "").toLowerCase() === new URL(expectedOrigin).host.toLowerCase();
}

export function isRouteAllowed(role, pathname) {
  if (role === "content") {
    return pathname === "/healthz" || /^\/view\/[0-9a-f-]{36}(?:\/.*)?$/i.test(pathname);
  }
  return true;
}

export function getVercelHostDecision(requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const { adminOrigin, publicOrigin } = getRuntimeConfig();
  const requestHost = url.host.toLowerCase();
  const adminHost = new URL(adminOrigin).host.toLowerCase();
  const publicHost = new URL(publicOrigin).host.toLowerCase();

  if (requestHost === publicHost) {
    const publicPath = url.pathname === "/healthz"
      || /^\/view\/[0-9a-f-]{36}(?:\/.*)?$/i.test(url.pathname);
    return { action: publicPath ? "next" : "not-found" };
  }

  if (requestHost === adminHost) {
    if (/^\/view\/[0-9a-f-]{36}(?:\/.*)?$/i.test(url.pathname)) {
      return {
        action: "redirect",
        location: new URL(`${url.pathname}${url.search}`, publicOrigin).href
      };
    }
    return { action: "next" };
  }

  return { action: "misdirected" };
}
