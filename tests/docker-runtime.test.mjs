import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const DOCKERFILE_PATH = "Dockerfile";
const COMPOSE_PATH = "docker-compose.yml";

function serviceBlock(compose, serviceName) {
  const escaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return compose.match(new RegExp(`^  ${escaped}:\\s*$([\\s\\S]*?)(?=^  [\\w-]+:\\s*$|^volumes:\\s*$)`, "m"))?.[1] || "";
}

test("Dockerfile installs production dependencies from the lockfile", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");

  assert.match(dockerfile, /^RUN npm ci --omit=dev\s*$/m);
  assert.doesNotMatch(dockerfile, /^RUN npm install --omit=dev\s*$/m);
});

test("Dockerfile prepares /data before switching to the node user", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const mkdirIndex = dockerfile.search(/\bmkdir\s+-p\s+\/data\b/);
  const chownIndex = dockerfile.search(/\bchown(?:\s+-R)?\s+node:node\s+\/data\b/);
  const userIndex = dockerfile.search(/^USER node\s*$/m);

  assert.notEqual(mkdirIndex, -1, "Dockerfile must create /data");
  assert.notEqual(chownIndex, -1, "Dockerfile must chown /data to node:node");
  assert.notEqual(userIndex, -1, "Dockerfile must run as USER node");
  assert.ok(mkdirIndex < userIndex, "/data must be created before USER node");
  assert.ok(chownIndex < userIndex, "/data must be owned before USER node");
});

test("Dockerfile exposes both role ports and probes the configured health endpoint", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const healthcheck = dockerfile.split(/\r?\n/).find((line) => line.startsWith("HEALTHCHECK "));

  assert.match(dockerfile, /^EXPOSE 3000 3001\s*$/m);
  assert.ok(healthcheck, "Dockerfile must define HEALTHCHECK");
  assert.match(healthcheck, /\bnode\b/);
  assert.match(healthcheck, /\/healthz\b/);
  assert.match(healthcheck, /process\.env\.PORT/);
  assert.match(healthcheck, /process\.env\.HEALTHCHECK_HOST/);
  assert.doesNotMatch(healthcheck, /\bcurl\b/i);
});

test("Compose runs separate loopback-only admin and content roles", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");
  const admin = serviceBlock(compose, "admin");
  const content = serviceBlock(compose, "content");

  assert.ok(admin, "Compose must define the admin service");
  assert.ok(content, "Compose must define the content service");
  assert.match(admin, /HTML_WORKBENCH_ROLE:\s*admin/);
  assert.match(admin, /PORT:\s*3000/);
  assert.match(admin, /^\s*-\s*["']127\.0\.0\.1:3000:3000["']\s*$/m);
  assert.match(admin, /^\s*-\s*html-workbench-data:\/data\s*$/m);
  assert.match(content, /HTML_WORKBENCH_ROLE:\s*content/);
  assert.match(content, /PORT:\s*3001/);
  assert.match(content, /^\s*-\s*["']127\.0\.0\.1:3001:3001["']\s*$/m);
  assert.match(content, /^\s*-\s*html-workbench-data:\/data:ro\s*$/m);
  assert.doesNotMatch(compose, /^\s*-\s*["']3000:3000["']\s*$/m);
  assert.doesNotMatch(compose, /^\s*-\s*["']3001:3001["']\s*$/m);
});

test("Compose configures production origins and requires every credential", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");
  const admin = serviceBlock(compose, "admin");

  for (const name of [
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET"
  ]) {
    assert.match(admin, new RegExp(`${name}:\\s*["']?\\$\\{${name}:\\?[^}\\r\\n]+\\}["']?`));
  }
  assert.match(compose, /HTML_WORKBENCH_ADMIN_ORIGIN:\s*https:\/\/ho\.wekki\.fun/);
  assert.match(compose, /HTML_WORKBENCH_PUBLIC_ORIGIN:\s*https:\/\/page\.wekki\.fun/);
});

test("Compose healthchecks use each role's port and public Host", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");
  const admin = serviceBlock(compose, "admin");
  const content = serviceBlock(compose, "content");

  assert.match(admin, /HEALTHCHECK_HOST:\s*ho\.wekki\.fun/);
  assert.match(admin, /^\s{6}test:.*\bnode\b.*\/healthz\b.*3000.*$/m);
  assert.match(content, /HEALTHCHECK_HOST:\s*page\.wekki\.fun/);
  assert.match(content, /^\s{6}test:.*\bnode\b.*\/healthz\b.*3001.*$/m);
  assert.doesNotMatch(`${admin}\n${content}`, /^\s{6}test:.*\bcurl\b.*$/mi);
});

test("Compose initializes volume ownership before either role starts", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");
  const admin = serviceBlock(compose, "admin");
  const content = serviceBlock(compose, "content");

  assert.match(compose, /^\s{2}html-workbench-init:\s*$/m);
  assert.match(compose, /^\s{4}user:\s*["']?root["']?\s*$/m);
  assert.match(compose, /^\s{4}command:.*chown.*node:node.*\/data.*$/m);
  for (const service of [admin, content]) {
    assert.match(service, /^\s{4}depends_on:\s*$/m);
    assert.match(service, /html-workbench-init:[\s\S]*condition:\s*service_completed_successfully/);
  }
});

test("README configures required credentials before Compose startup", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const composeSection = readme.match(/### [^\r\n]*Docker Compose([\s\S]*?)(?=\r?\n### |\s*$)/)?.[1] || "";
  const upIndex = composeSection.indexOf("docker compose up");

  assert.notEqual(upIndex, -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_PASSWORD"), -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_AUTH_SECRET"), -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_DOWNLOAD_PASSWORD"), -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_CURSOR_SECRET"), -1);
  assert.ok(composeSection.indexOf("HTML_WORKBENCH_PASSWORD") < upIndex);
  assert.ok(composeSection.indexOf("HTML_WORKBENCH_AUTH_SECRET") < upIndex);
  assert.match(composeSection, /127\.0\.0\.1:3000/);
  assert.match(composeSection, /127\.0\.0\.1:3001/);
});
