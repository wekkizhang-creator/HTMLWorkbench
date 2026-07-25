import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

function assertOrdered(source, patterns) {
  let cursor = -1;
  for (const pattern of patterns) {
    const match = source.slice(cursor + 1).search(pattern);
    assert.notEqual(match, -1, `missing ordered deployment step: ${pattern}`);
    cursor += match + 1;
  }
}

test("self-host deployment installs two loopback-only services", async () => {
  const [adminService, contentService, environment, deployScript] = await Promise.all([
    fs.readFile("deploy/self-host/html-workbench.service", "utf8"),
    fs.readFile("deploy/self-host/html-workbench-content.service", "utf8"),
    fs.readFile("deploy/self-host/html-workbench.env.example", "utf8"),
    fs.readFile("deploy/self-host/deploy.sh", "utf8")
  ]);

  for (const service of [adminService, contentService]) {
    assert.match(service, /^User=htmlworkbench$/m);
    assert.match(service, /^Group=htmlworkbench$/m);
    assert.match(service, /^EnvironmentFile=-?\/etc\/html-workbench\.env$/m);
    assert.match(service, /^Environment=HOST=127\.0\.0\.1$/m);
  }
  assert.match(adminService, /^Environment=HTML_WORKBENCH_ROLE=admin$/m);
  assert.match(adminService, /^Environment=PORT=3000$/m);
  assert.match(adminService, /^ReadWritePaths=\/var\/lib\/html-workbench$/m);
  assert.match(contentService, /^Environment=HTML_WORKBENCH_ROLE=content$/m);
  assert.match(contentService, /^Environment=PORT=3001$/m);
  assert.match(contentService, /^ProtectSystem=strict$/m);
  assert.match(contentService, /^ReadOnlyPaths=\/var\/lib\/html-workbench$/m);
  assert.doesNotMatch(contentService, /^ReadWritePaths=/m);

  assert.match(environment, /^HTML_WORKBENCH_ADMIN_ORIGIN=https:\/\/ho\.wekki\.fun$/m);
  assert.match(environment, /^HTML_WORKBENCH_PUBLIC_ORIGIN=https:\/\/page\.wekki\.fun$/m);
  assert.doesNotMatch(environment, /885688/);
  assert.match(deployScript, /html-workbench-content\.service/);
});

test("self-host deployment gates both services on the live record-index migration", async () => {
  const deployScript = await fs.readFile("deploy/self-host/deploy.sh", "utf8");

  assert.match(deployScript, /npm ci --omit=dev/);
  assert.doesNotMatch(deployScript, /npm install --omit=dev/);
  assert.match(deployScript, /trap\s+\w+\s+EXIT/);
  assert.match(deployScript, /systemctl stop html-workbench/);
  assert.match(deployScript, /systemctl stop html-workbench-content/);
  assert.match(deployScript, /npm run migrate:record-index/);
  assert.doesNotMatch(deployScript, /migrate:record-index:recover/);
  assert.match(deployScript, /systemctl start html-workbench/);
  assert.match(deployScript, /migration failed/i);

  assertOrdered(deployScript, [
    /npm ci --omit=dev/,
    /systemctl stop html-workbench/,
    /npm run migrate:record-index/,
    /systemctl daemon-reload/,
    /systemctl (?:restart|start) html-workbench html-workbench-content/,
    /http:\/\/127\.0\.0\.1:3000\/healthz/,
    /http:\/\/127\.0\.0\.1:3001\/healthz/,
    /nginx -t/,
    /systemctl reload nginx/
  ]);
});

test("nginx isolates the admin and public hosts", async () => {
  const nginx = await fs.readFile("deploy/self-host/nginx.conf", "utf8");

  assert.match(nginx, /server_name ho\.wekki\.fun/);
  assert.match(nginx, /server_name page\.wekki\.fun/);
  assert.match(nginx, /client_max_body_size 30m/);
  assert.match(nginx, /location \^~ \/view\/\s*\{[\s\S]*return 307 https:\/\/page\.wekki\.fun\$request_uri/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000/);
  assert.match(nginx, /location \^~ \/api\/\s*\{[\s\S]*?return 404/);
  assert.match(nginx, /location \^~ \/view\/\s*\{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3001/);
  assert.match(nginx, /location = \/healthz\s*\{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3001/);
  assert.match(nginx, /location \/\s*\{\s*return 404/);

  const forwardedHeaderCount = (nginx.match(/proxy_set_header X-Forwarded-For/g) || []).length;
  assert.ok(forwardedHeaderCount >= 3, "every proxy route must preserve forwarded headers");
});

test("README documents the production DNS, migration modes, health, certificates, and rollback", async () => {
  const readme = await fs.readFile("README.md", "utf8");

  for (const line of [
    "Host record: page",
    "Type: A",
    "Value: 163.7.4.158",
    "TTL: 600",
    "HTML_WORKBENCH_ADMIN_ORIGIN",
    "HTML_WORKBENCH_PUBLIC_ORIGIN",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET",
    "migrate:record-index:dry-run",
    "migrate:record-index",
    "migrate:record-index:recover",
    "systemctl status html-workbench",
    "systemctl status html-workbench-content",
    "http://127.0.0.1:3000/healthz",
    "http://127.0.0.1:3001/healthz",
    "certbot --nginx -d page.wekki.fun"
  ]) {
    assert.match(readme, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(readme, /stop-the-world/i);
  assert.match(readme, /previous Git commit/i);
});

test("GitHub deployment delegates to the checked-in migration-gated script", async () => {
  const workflow = await fs.readFile(".github/workflows/deploy-self-host.yml", "utf8");

  assert.match(workflow, /deploy\/self-host\/deploy\.sh/);
  assert.match(workflow, /APP_DIR/);
  assert.match(workflow, /BRANCH/);
  assert.match(workflow, /REPO_URL/);
  assert.match(workflow, /SERVER_REPO_URL contains unsafe characters/);
  assert.doesNotMatch(workflow, /npm (?:--prefix "\$APP_DIR" )?install --omit=dev/);
});

test("Vercel routes /healthz to the health API", async () => {
  const config = JSON.parse(await fs.readFile("vercel.json", "utf8"));
  assert.ok(config.rewrites.some((rewrite) => (
    rewrite.source === "/healthz" && rewrite.destination === "/api/health"
  )));
  await fs.access("api/health.mjs");
});
