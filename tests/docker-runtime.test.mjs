import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const DOCKERFILE_PATH = "Dockerfile";
const COMPOSE_PATH = "docker-compose.yml";

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

test("Dockerfile healthcheck uses Node to probe /healthz", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const healthcheck = dockerfile.split(/\r?\n/).find((line) => line.startsWith("HEALTHCHECK "));

  assert.ok(healthcheck, "Dockerfile must define HEALTHCHECK");
  assert.match(healthcheck, /\bnode\b/);
  assert.match(healthcheck, /\/healthz\b/);
  assert.doesNotMatch(healthcheck, /\bcurl\b/i);
});

test("Compose binds the application port only to loopback", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");

  assert.match(compose, /^\s*-\s*["']127\.0\.0\.1:3000:3000["']\s*$/m);
  assert.doesNotMatch(compose, /^\s*-\s*["']3000:3000["']\s*$/m);
});

test("Compose requires production password and authentication secret", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");

  assert.match(
    compose,
    /HTML_WORKBENCH_PASSWORD:\s*["']?\$\{HTML_WORKBENCH_PASSWORD:\?[^}\r\n]+\}["']?/
  );
  assert.match(
    compose,
    /HTML_WORKBENCH_AUTH_SECRET:\s*["']?\$\{HTML_WORKBENCH_AUTH_SECRET:\?[^}\r\n]+\}["']?/
  );
});

test("Compose healthcheck uses Node to probe /healthz", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");
  const healthcheckIndex = compose.search(/^\s{4}healthcheck:\s*$/m);
  const healthcheckBlock = healthcheckIndex === -1 ? "" : compose.slice(healthcheckIndex);

  assert.notEqual(healthcheckIndex, -1, "Compose service must define healthcheck");
  assert.match(healthcheckBlock, /^\s{6}test:.*\bnode\b.*\/healthz\b.*$/m);
  assert.doesNotMatch(healthcheckBlock, /^\s{6}test:.*\bcurl\b.*$/mi);
});
test("Docker healthchecks honor the configured application port", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");

  assert.match(dockerfile, /process\.env\.PORT/);
  assert.match(compose, /process\.env\.PORT/);
});

test("Compose initializes existing volume ownership before the app starts", async () => {
  const compose = await fs.readFile(COMPOSE_PATH, "utf8");

  assert.match(compose, /^\s{2}html-workbench-init:\s*$/m);
  assert.match(compose, /^\s{4}user:\s*["']?root["']?\s*$/m);
  assert.match(compose, /^\s{4}command:.*chown.*node:node.*\/data.*$/m);
  assert.match(compose, /^\s{4}depends_on:\s*$/m);
  assert.match(compose, /condition:\s*service_completed_successfully/);
});

test("README configures required credentials before Compose startup", async () => {
  const readme = await fs.readFile("README.md", "utf8");
  const composeSection = readme.match(/### [^\r\n]*Docker Compose([\s\S]*?)(?=\r?\n### |\s*$)/)?.[1] || "";
  const upIndex = composeSection.indexOf("docker compose up");

  assert.notEqual(upIndex, -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_PASSWORD"), -1);
  assert.notEqual(composeSection.indexOf("HTML_WORKBENCH_AUTH_SECRET"), -1);
  assert.ok(composeSection.indexOf("HTML_WORKBENCH_PASSWORD") < upIndex);
  assert.ok(composeSection.indexOf("HTML_WORKBENCH_AUTH_SECRET") < upIndex);
  assert.match(composeSection, /127\.0\.0\.1:3000/);
});