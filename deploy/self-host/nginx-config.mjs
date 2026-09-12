export const MANAGED_HOST_MARKER = "# HTML_WORKBENCH_MANAGED_HOST_V1";
export const ADMIN_SNIPPET_PATH = "/etc/nginx/snippets/html-workbench-admin-routes.conf";
export const CONTENT_SNIPPET_PATH = "/etc/nginx/snippets/html-workbench-content-routes.conf";

const PROXY_HEADERS = `        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;

export const ADMIN_ROUTES = `# Managed by HTMLWorkbench deploy; local edits are overwritten.
client_max_body_size 32m;

location = /view {
    return 307 https://page.wekki.fun$request_uri;
}

location ^~ /view/ {
    return 307 https://page.wekki.fun$request_uri;
}

location / {
    proxy_pass http://127.0.0.1:3000;
${PROXY_HEADERS}
}
`;

export const CONTENT_ROUTES = `# Managed by HTMLWorkbench deploy; local edits are overwritten.
location ^~ /api/ { return 404; }
location = /index.html { return 404; }
location = /login { return 404; }
location = /login.html { return 404; }
location = /styles.css { return 404; }
location = /app.js { return 404; }
location = /brand-logo.png { return 404; }
location ^~ /public-download-widget/ { return 404; }

location ^~ /view/ {
    proxy_pass http://127.0.0.1:3001;
${PROXY_HEADERS}
}

location = /healthz {
    proxy_pass http://127.0.0.1:3001;
${PROXY_HEADERS}
}

location / { return 404; }
`;

function bootstrapPageServer() {
  return `server {
    listen 80;
    server_name page.wekki.fun;
    include ${CONTENT_SNIPPET_PATH};
}`;
}

export function bootstrapHostConfig() {
  return `${MANAGED_HOST_MARKER}
server {
    listen 80;
    server_name ho.wekki.fun;
    include ${ADMIN_SNIPPET_PATH};
}

${bootstrapPageServer()}
`;
}

function serverBlocks(contents) {
  const blocks = [];
  const matcher = /\bserver\s*\{/g;
  let match;
  while ((match = matcher.exec(contents))) {
    let depth = 0;
    let end = -1;
    for (let index = match.index; index < contents.length; index += 1) {
      if (contents[index] === "{") depth += 1;
      if (contents[index] === "}") {
        depth -= 1;
        if (depth === 0) { end = index + 1; break; }
      }
    }
    if (end === -1) throw new Error("Cannot adopt malformed Nginx server block");
    blocks.push({ start: match.index, end, source: contents.slice(match.index, end) });
    matcher.lastIndex = end;
  }
  return blocks;
}

function removeLocations(block) {
  const lines = block.split(/(?<=\n)/);
  const kept = [];
  let depth = 0;
  let skippingDepth = null;
  for (const line of lines) {
    const before = depth;
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (skippingDepth === null && before === 1 && /^\s*location\b/.test(line)) skippingDepth = before;
    depth += opens - closes;
    if (skippingDepth === null) kept.push(line);
    else if (depth === skippingDepth) skippingDepth = null;
  }
  return kept.join("");
}

function withInclude(block, includePath) {
  let withoutLocations = removeLocations(block).replace(new RegExp(`^\\s*include\\s+${includePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;\\s*$`, "gm"), "");
  if (includePath === ADMIN_SNIPPET_PATH) {
    withoutLocations = withoutLocations.replace(/^\s*client_max_body_size\s+[^;]+;[^\S\r\n]*(?:#[^\r\n]*)?$/gm, "");
  }
  const closing = withoutLocations.lastIndexOf("}");
  return `${withoutLocations.slice(0, closing).trimEnd()}\n    include ${includePath};\n${withoutLocations.slice(closing)}`;
}

function replaceSelectedBlocks(contents, host, includePath) {
  const matching = serverBlocks(contents).filter(({ source }) => new RegExp(`\\bserver_name\\s+[^;]*\\b${host.replace(/\./g, "\\.")}\\b[^;]*;`).test(source));
  if (matching.length === 0) return { contents, found: false };
  const tls = matching.filter(({ source }) => /\blisten\s+[^;]*443\b|\bssl_certificate\b/.test(source));
  const selected = new Set((tls.length ? tls : matching).map(({ start }) => start));
  let result = "";
  let cursor = 0;
  for (const block of serverBlocks(contents)) {
    result += contents.slice(cursor, block.start);
    result += selected.has(block.start) ? withInclude(block.source, includePath) : block.source;
    cursor = block.end;
  }
  result += contents.slice(cursor);
  return { contents: result, found: true };
}

export function buildManagedHostConfig(existingContents) {
  if (existingContents == null) return bootstrapHostConfig();
  if (existingContents.includes(MANAGED_HOST_MARKER)) return existingContents;

  const admin = replaceSelectedBlocks(existingContents, "ho.wekki.fun", ADMIN_SNIPPET_PATH);
  if (!admin.found) throw new Error("Existing Nginx host file does not contain ho.wekki.fun; refusing to replace it");
  const content = replaceSelectedBlocks(admin.contents, "page.wekki.fun", CONTENT_SNIPPET_PATH);
  const adopted = content.found ? content.contents : `${admin.contents.trimEnd()}\n\n${bootstrapPageServer()}\n`;
  return `${MANAGED_HOST_MARKER}\n${adopted}`;
}
