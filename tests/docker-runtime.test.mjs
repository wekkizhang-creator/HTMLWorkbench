import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";

const DOCKERFILE_PATH = "Dockerfile";
const COMPOSE_PATH = "docker-compose.yml";

function parseComposeServices(compose) {
  const services = new Map();
  let current = null;
  let inDependsOn = false;
  let dependency = null;

  for (const line of compose.split(/\r?\n/)) {
    const serviceMatch = line.match(/^  ([\w-]+):\s*$/);
    if (serviceMatch) {
      current = { dependencies: new Map(), source: "" };
      services.set(serviceMatch[1], current);
      inDependsOn = false;
      dependency = null;
      continue;
    }
    if (!current || /^volumes:\s*$/.test(line)) {
      if (/^volumes:\s*$/.test(line)) current = null;
      continue;
    }
    current.source += `${line}\n`;
    if (/^    depends_on:\s*$/.test(line)) {
      inDependsOn = true;
      dependency = null;
      continue;
    }
    if (inDependsOn) {
      const dependencyMatch = line.match(/^      ([\w-]+):\s*$/);
      if (dependencyMatch) {
        dependency = dependencyMatch[1];
        current.dependencies.set(dependency, null);
        continue;
      }
      const conditionMatch = line.match(/^        condition:\s*(\S+)\s*$/);
      if (conditionMatch && dependency) {
        current.dependencies.set(dependency, conditionMatch[1]);
        continue;
      }
      if (/^    \S/.test(line)) {
        inDependsOn = false;
        dependency = null;
      }
    }
  }
  return services;
}

function serviceCanStart(service, completedServices) {
  return [...service.dependencies].every(([name, condition]) =>
    condition === "service_completed_successfully" && completedServices.get(name) === 0
  );
}

function containerEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    NODE_ENV: "production",
    HTML_WORKBENCH_DATA_DIR: "/data",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun",
    HTML_WORKBENCH_PASSWORD: "885688",
    HTML_WORKBENCH_AUTH_SECRET: "production auth secret",
    HTML_WORKBENCH_DOWNLOAD_PASSWORD: "885688",
    HTML_WORKBENCH_CURSOR_SECRET: "production cursor secret",
    ...overrides
  };
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete environment[name];
  }
  return environment;
}

function runContainerEntrypoint(entrypoint, overrides = {}) {
  return spawnSync(
    process.execPath,
    [entrypoint, process.execPath, "-e", "process.exit(0)"],
    { encoding: "utf8", env: containerEnvironment(overrides) }
  );
}
test("Dockerfile installs locked production dependencies and supports both roles", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const healthcheck = dockerfile.split(/\r?\n/).find((line) => line.startsWith("HEALTHCHECK "));

  assert.match(dockerfile, /^RUN npm ci --omit=dev\s*$/m);
  assert.doesNotMatch(dockerfile, /^RUN npm install --omit=dev\s*$/m);
  assert.match(dockerfile, /^EXPOSE 3000 3001\s*$/m);
  assert.match(dockerfile, /^USER node\s*$/m);
  assert.ok(healthcheck);
  assert.match(healthcheck, /process\.env\.PORT/);
  assert.match(healthcheck, /process\.env\.HEALTHCHECK_HOST/);
});

test("Docker entrypoint validates credentials before every service command", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");
  const entrypointMatch = dockerfile.match(/^ENTRYPOINT \["node", "([^"]+)"\]\s*$/m);
  assert.ok(entrypointMatch, "Dockerfile must install the production validation entrypoint");

  const valid = runContainerEntrypoint(entrypointMatch[1]);
  assert.equal(valid.status, 0, valid.stderr);

  for (const [name, value] of [
    ["HTML_WORKBENCH_PASSWORD", undefined],
    ["HTML_WORKBENCH_DOWNLOAD_PASSWORD", ""],
    ["HTML_WORKBENCH_AUTH_SECRET", "change-this-auth-secret"],
    ["HTML_WORKBENCH_CURSOR_SECRET", "change-this-cursor-secret"]
  ]) {
    const result = runContainerEntrypoint(entrypointMatch[1], { [name]: value });
    assert.notEqual(result.status, 0, `${name} unexpectedly passed validation`);
    assert.match(result.stderr, new RegExp(name));
  }
});
test("migration failure blocks both long-running Compose roles", async () => {
  const services = parseComposeServices(await fs.readFile(COMPOSE_PATH, "utf8"));
  for (const name of ["html-workbench-init", "migration", "admin", "content"]) {
    assert.ok(services.has(name), `Compose must define ${name}`);
  }

  const migration = services.get("migration");
  const admin = services.get("admin");
  const content = services.get("content");
  assert.equal(migration.dependencies.get("html-workbench-init"), "service_completed_successfully");
  assert.equal(admin.dependencies.get("migration"), "service_completed_successfully");
  assert.equal(content.dependencies.get("migration"), "service_completed_successfully");

  const failedMigration = new Map([["html-workbench-init", 0], ["migration", 1]]);
  assert.equal(serviceCanStart(admin, failedMigration), false);
  assert.equal(serviceCanStart(content, failedMigration), false);
  const successfulMigration = new Map([["html-workbench-init", 0], ["migration", 0]]);
  assert.equal(serviceCanStart(admin, successfulMigration), true);
  assert.equal(serviceCanStart(content, successfulMigration), true);
});

test("Compose migration writes shared data while content mounts it read-only", async () => {
  const services = parseComposeServices(await fs.readFile(COMPOSE_PATH, "utf8"));
  const migration = services.get("migration")?.source || "";
  const admin = services.get("admin")?.source || "";
  const content = services.get("content")?.source || "";

  assert.match(migration, /command:\s*\["npm", "run", "migrate:record-index"\]/);
  assert.match(migration, /^\s*-\s*html-workbench-data:\/data\s*$/m);
  assert.match(admin, /^\s*-\s*["']127\.0\.0\.1:3000:3000["']\s*$/m);
  assert.match(admin, /^\s*-\s*html-workbench-data:\/data\s*$/m);
  assert.match(content, /^\s*-\s*["']127\.0\.0\.1:3001:3001["']\s*$/m);
  assert.match(content, /^\s*-\s*html-workbench-data:\/data:ro\s*$/m);
});

test("Compose uses role-specific healthchecks and requires credentials for every application role", async () => {
  const services = parseComposeServices(await fs.readFile(COMPOSE_PATH, "utf8"));
  const migration = services.get("migration")?.source || "";
  const admin = services.get("admin")?.source || "";
  const content = services.get("content")?.source || "";

  assert.match(admin, /HEALTHCHECK_HOST:\s*ho\.wekki\.fun/);
  assert.match(admin, /\/healthz.*3000/);
  assert.match(content, /HEALTHCHECK_HOST:\s*page\.wekki\.fun/);
  assert.match(content, /\/healthz.*3001/);
  for (const name of [
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET"
  ]) {
    assert.match(migration, new RegExp(`${name}:\\s*["']?\\$\\{${name}:\\?[^}\\r\\n]+\\}["']?`));
    assert.match(admin, new RegExp(`${name}:\\s*["']?\\$\\{${name}:\\?[^}\\r\\n]+\\}["']?`));
    assert.match(content, new RegExp(`${name}:\\s*["']?\\$\\{${name}:\\?[^}\\r\\n]+\\}["']?`));
  }
});
