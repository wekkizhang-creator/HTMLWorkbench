import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeploymentPaths, deployRelease } from "../deploy/self-host/deploy.mjs";
import { parseSystemdEnvironmentFile, validateEffectiveEnvironment } from "../deploy/self-host/validate-env.mjs";
import { buildManagedHostConfig, MANAGED_HOST_MARKER } from "../deploy/self-host/nginx-config.mjs";

const DEPLOY_SHA = "a".repeat(40);
const REPO_URL = "https://github.com/wekkizhang-creator/HTMLWorkbench.git";
const ADMIN_SERVICE = "html-workbench.service";
const CONTENT_SERVICE = "html-workbench-content.service";

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function createDirectoryLink(target, linkPath) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function certbotHostConfig() {
  return `server {
    listen 443 ssl;
    server_name ho.wekki.fun;
    ssl_certificate /etc/letsencrypt/live/ho.wekki.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ho.wekki.fun/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}

server {
    listen 80;
    server_name ho.wekki.fun;
    return 301 https://$host$request_uri;
}
`;
}

function validEnvironmentFile() {
  return `HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_ADMIN_ORIGIN="https://ho.wekki.fun"
HTML_WORKBENCH_PUBLIC_ORIGIN='https://page.wekki.fun'
HTML_WORKBENCH_PASSWORD=old-value
HTML_WORKBENCH_PASSWORD="885688"
HTML_WORKBENCH_AUTH_SECRET='oJPyDUkzBK7U78fZp1yJhMUJ8iL8dGeK6cX4HnJrT40'
HTML_WORKBENCH_DOWNLOAD_PASSWORD="885688"
HTML_WORKBENCH_CURSOR_SECRET='production cursor secret'
`;
}

async function copyReleaseFixture(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp("deploy", path.join(targetDir, "deploy"), { recursive: true });
  for (const fileName of ["package.json", "package-lock.json", "server.js"]) {
    await fs.copyFile(fileName, path.join(targetDir, fileName));
  }
}

async function createHarness(options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "html-workbench-deploy-"));
  const paths = createDeploymentPaths({ rootDir });
  const previousRelease = path.join(paths.releasesDir, "previous-release");
  const logs = [];
  const commands = [];
  const serviceState = {
    active: new Map([[ADMIN_SERVICE, options.adminActive ?? true], [CONTENT_SERVICE, options.contentActive ?? true]]),
    enabled: new Map([[ADMIN_SERVICE, options.adminEnabled ?? true], [CONTENT_SERVICE, options.contentEnabled ?? true]])
  };
  const activationObserved = {};

  await fs.mkdir(paths.appDir, { recursive: true });
  await writeFile(path.join(paths.appDir, "legacy-sentinel.txt"), "legacy checkout remains untouched");
  await writeFile(paths.envFile, options.environmentFile ?? validEnvironmentFile());
  await writeFile(paths.contentEnvFile, options.contentEnvironmentFile ?? "OLD_CONTENT_ENV=preserve\n");
  await writeFile(
    paths.adminUnit,
    options.adminUnit ?? "[Service]\nUser=htmlworkbench\nGroup=htmlworkbench\n"
  );
  if (options.contentUnitExists !== false) await writeFile(paths.contentUnit, "old content unit\n");
  if (options.hostExists !== false) await writeFile(paths.nginxHost, options.hostConfig ?? certbotHostConfig());
  await writeFile(paths.adminSnippet, "old admin routes\n");
  await writeFile(paths.contentSnippet, "old content routes\n");

  if (options.previousCurrent !== false) {
    await fs.mkdir(previousRelease, { recursive: true });
    await writeFile(path.join(previousRelease, "server.js"), "previous release\n");
    await createDirectoryLink(previousRelease, paths.currentLink);
  }

  let nginxTestCount = 0;
  const run = async (command, args = [], runOptions = {}) => {
    commands.push({ command, args: [...args], cwd: runOptions.cwd });
    if (command === "getent" && args[0] === "group") return { code: 2, stdout: "", stderr: "" };
    if (command === "id") return { code: 1, stdout: "", stderr: "" };
    if (command === "git" && args[0] === "checkout") await copyReleaseFixture(runOptions.cwd);
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: `${DEPLOY_SHA}\n`, stderr: "" };
    if (command === "systemctl" && args[0] === "is-active") {
      if (options.systemctlIsActiveFails && args.at(-1) === ADMIN_SERVICE) {
        return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      const active = serviceState.active.get(args.at(-1));
      return { code: active ? 0 : 3, stdout: active ? "active\n" : "inactive\n", stderr: "" };
    }
    if (command === "systemctl" && args[0] === "is-enabled") {
      if (options.systemctlIsEnabledFails && args.at(-1) === ADMIN_SERVICE) {
        return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      const enabled = serviceState.enabled.get(args.at(-1));
      return { code: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n", stderr: "" };
    }
    if (command === "systemctl" && args[0] === "show") {
      if (options.systemctlShowFails && args.at(-1) === ADMIN_SERVICE) {
        return { code: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      const unitPath = args.at(-1) === ADMIN_SERVICE ? paths.adminUnit : paths.contentUnit;
      return { code: 0, stdout: (await exists(unitPath)) ? "loaded\n" : "not-found\n", stderr: "" };
    }
    if (command === "systemctl" && ["stop", "start", "restart"].includes(args[0])) {
      for (const service of args.slice(1)) serviceState.active.set(service, args[0] !== "stop");
    }
    if (command === "systemctl" && ["enable", "disable"].includes(args[0])) {
      for (const service of args.slice(1)) serviceState.enabled.set(service, args[0] === "enable");
    }
    if (command === "systemd-run" && args.some((arg) => arg.endsWith("validate-env.mjs"))) {
      try {
        const environmentArgument = args.find((arg) => arg.startsWith("--property=EnvironmentFile="));
        const environmentFile = environmentArgument.slice("--property=EnvironmentFile=".length);
        const profileIndex = args.indexOf("--profile");
        validateEffectiveEnvironment(
          parseSystemdEnvironmentFile(await fs.readFile(environmentFile, "utf8")),
          { profile: profileIndex === -1 ? "host" : args[profileIndex + 1] }
        );
      } catch (error) {
        return { code: 1, stdout: "", stderr: error.message };
      }
    }
    if (command === "systemd-run" && args.includes("migrate:record-index") && options.migrationFails) {
      return { code: 1, stdout: "", stderr: "migration failed" };
    }
    if (command === "nginx" && args[0] === "-t") {
      nginxTestCount += 1;
      if (options.postStartNginxFails && nginxTestCount === 2) {
        activationObserved.currentTarget = await fs.readlink(paths.currentLink);
        activationObserved.adminUnit = await fs.readFile(paths.adminUnit, "utf8");
        activationObserved.contentUnit = await fs.readFile(paths.contentUnit, "utf8");
        activationObserved.nginxHost = await fs.readFile(paths.nginxHost, "utf8");
        activationObserved.adminSnippet = await fs.readFile(paths.adminSnippet, "utf8");
        activationObserved.contentSnippet = await fs.readFile(paths.contentSnippet, "utf8");
        activationObserved.adminActive = serviceState.active.get(ADMIN_SERVICE);
        activationObserved.contentActive = serviceState.active.get(CONTENT_SERVICE);
        activationObserved.adminEnabled = serviceState.enabled.get(ADMIN_SERVICE);
        activationObserved.contentEnabled = serviceState.enabled.get(CONTENT_SERVICE);
        return { code: 1, stdout: "", stderr: "invalid final nginx" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  return {
    activationObserved, cleanup: () => fs.rm(rootDir, { force: true, recursive: true }), commands, logs, paths,
    previousRelease, run, serviceState
  };
}

function commandIndex(commands, predicate) { return commands.findIndex(predicate); }

test("first install stages the exact SHA without mutating the legacy checkout", async () => {
  const harness = await createHarness({ contentActive: false, contentEnabled: false, contentUnitExists: false, previousCurrent: false });
  try {
    await deployRelease({ deploySha: DEPLOY_SHA, log: (message) => harness.logs.push(message), paths: harness.paths, repoUrl: REPO_URL, run: harness.run });
    assert.equal(await fs.readFile(path.join(harness.paths.appDir, "legacy-sentinel.txt"), "utf8"), "legacy checkout remains untouched");
    assert.equal(path.resolve(await fs.readlink(harness.paths.currentLink)), path.resolve(harness.paths.releaseDir(DEPLOY_SHA)));
    assert.ok(await exists(path.join(harness.paths.releaseDir(DEPLOY_SHA), ".html-workbench-release-ready")));
    assert.ok(await exists(harness.paths.contentUnit), "missing content unit is installed during activation");
    assert.equal(harness.commands.some(({ command, args }) => command === "git" && args.includes("reset")), false);
    const fetch = harness.commands.find(({ command, args }) => command === "git" && args[0] === "fetch");
    assert.deepEqual(fetch.args.slice(-2), ["origin", DEPLOY_SHA]);
    const npmInstall = harness.commands.find(({ command, args }) => command === "npm" && args[0] === "ci");
    assert.notEqual(path.resolve(npmInstall.cwd), path.resolve(harness.paths.appDir));
    assert.match(path.resolve(npmInstall.cwd), new RegExp(path.basename(harness.paths.releasesDir)));
    const preflightIndex = commandIndex(harness.commands, ({ command, args }) => command === "systemd-run" && args.some((arg) => arg.endsWith("validate-env.mjs")));
    const preflights = harness.commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.command === "systemd-run" && entry.args.some((arg) => arg.endsWith("validate-env.mjs")));
    const stopIndex = commandIndex(harness.commands, ({ command, args }) => command === "systemctl" && args[0] === "stop");
    const migrationIndex = commandIndex(harness.commands, ({ command, args }) => command === "systemd-run" && args.includes("migrate:record-index"));
    const dataPermissionIndex = commandIndex(harness.commands, ({ command, args }) =>
      command === "chown" && args.join(" ") === `-R htmlworkbench-admin:htmlworkbench-data ${harness.paths.dataDir}`
    );
    assert.ok(preflightIndex !== -1 && preflightIndex < stopIndex);
    assert.equal(preflights.length, 2);
    assert.ok(preflights.every(({ index }) => index < stopIndex));
    assert.match(preflights[1].entry.args.join(" "), /html-workbench-content\.env.*--profile content-host/);
    assert.ok(stopIndex < dataPermissionIndex, "data ownership changes only after the old services stop");
    assert.ok(dataPermissionIndex < migrationIndex, "data ownership is ready before migration");
    assert.ok(stopIndex < migrationIndex);
    assert.match(preflights[0].entry.args.join(" "), /User=htmlworkbench-admin.*Group=htmlworkbench-admin/);
    assert.match(preflights[1].entry.args.join(" "), /User=htmlworkbench-content.*Group=htmlworkbench-content/);
    const migration = harness.commands.find(({ command, args }) => command === "systemd-run" && args.includes("migrate:record-index"));
    assert.match(migration.args.join(" "), /User=htmlworkbench-admin.*Group=htmlworkbench-admin.*SupplementaryGroups=htmlworkbench-data/);
    assert.match(migration.args.join(" "), /UMask=0027/);
    assert.match(harness.commands[preflightIndex].args.join(" "), /EnvironmentFile=.*html-workbench\.env/);
    const healthIndexes = harness.commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.command === "curl")
      .map(({ index }) => index);
    const nginxTests = harness.commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.command === "nginx" && entry.args[0] === "-t")
      .map(({ index }) => index);
    const reloadIndex = commandIndex(harness.commands, ({ command, args }) => command === "systemctl" && args[0] === "reload" && args[1] === "nginx");
    assert.equal(healthIndexes.length, 2);
    assert.equal(nginxTests.length, 2);
    assert.ok(Math.max(...healthIndexes) < nginxTests.at(-1));
    assert.ok(nginxTests.at(-1) < reloadIndex);
    const hostConfig = await fs.readFile(harness.paths.nginxHost, "utf8");
    assert.match(hostConfig, new RegExp(MANAGED_HOST_MARKER));
    assert.match(hostConfig, /ssl_certificate \/etc\/letsencrypt\/live\/ho\.wekki\.fun\/fullchain\.pem/);
    assert.match(hostConfig, /server_name page\.wekki\.fun/);
    assert.match(hostConfig, /html-workbench-admin-routes\.conf/);
    assert.match(hostConfig, /html-workbench-content-routes\.conf/);
    const contentEnvironment = await fs.readFile(harness.paths.contentEnvFile, "utf8");
    assert.doesNotMatch(contentEnvironment, /PASSWORD|AUTH_SECRET|DOWNLOAD_PASSWORD|CURSOR_SECRET/);
    for (const group of ["htmlworkbench-admin", "htmlworkbench-content", "htmlworkbench-data"]) {
      assert.ok(harness.commands.some(({ command, args }) =>
        command === "groupadd" && args.includes("--system") && args.at(-1) === group
      ), `missing system group ${group}`);
    }
    for (const [user, group] of [
      ["htmlworkbench-admin", "htmlworkbench-admin"],
      ["htmlworkbench-content", "htmlworkbench-content"]
    ]) {
      assert.ok(harness.commands.some(({ command, args }) =>
        command === "useradd"
        && args.includes("--system")
        && args.includes("--gid")
        && args.includes(group)
        && args.at(-1) === user
      ), `missing isolated system user ${user}`);
    }
    assert.ok(harness.commands.some(({ command, args }) =>
      command === "chown" && args.join(" ") === `-R htmlworkbench-admin:htmlworkbench-data ${harness.paths.dataDir}`
    ));
    assert.ok(harness.commands.some(({ command, args }) =>
      command === "find" && args.join(" ").includes(`${harness.paths.dataDir} -type d -exec chmod 2750`)
    ));
    assert.ok(harness.commands.some(({ command, args }) =>
      command === "find" && args.join(" ").includes(`${harness.paths.dataDir} -type f -exec chmod 0640`)
    ));
    assert.ok(harness.commands.some(({ command, args }) =>
      command === "chown" && args.join(" ") === `root:htmlworkbench-admin ${harness.paths.envFile}`
    ));
    assert.ok(harness.commands.some(({ command, args }) =>
      command === "chown" && args.join(" ") === `root:htmlworkbench-content ${harness.paths.contentEnvFile}`
    ));
  } finally { await harness.cleanup(); }
});

test("a missing Nginx host bootstraps only the managed admin and page hosts", async () => {
  const harness = await createHarness({ hostExists: false, previousCurrent: false, contentUnitExists: false, contentActive: false, contentEnabled: false });
  try {
    await deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run });
    const hostConfig = await fs.readFile(harness.paths.nginxHost, "utf8");
    assert.match(hostConfig, new RegExp(MANAGED_HOST_MARKER));
    assert.match(hostConfig, /server_name ho\.wekki\.fun/);
    assert.match(hostConfig, /server_name page\.wekki\.fun/);
    assert.doesNotMatch(hostConfig, /oc\.|material\./);
  } finally { await harness.cleanup(); }
});
test("later deploys preserve the Certbot-managed host and update only route snippets", async () => {
  const managedHost = buildManagedHostConfig(certbotHostConfig());
  const harness = await createHarness({ hostConfig: managedHost });
  try {
    await deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run });
    assert.equal(await fs.readFile(harness.paths.nginxHost, "utf8"), managedHost);
    assert.notEqual(await fs.readFile(harness.paths.adminSnippet, "utf8"), "old admin routes\n");
    assert.notEqual(await fs.readFile(harness.paths.contentSnippet, "utf8"), "old content routes\n");
  } finally { await harness.cleanup(); }
});

test("migration failure restores the prior release and state but keeps content stopped", async () => {
  const harness = await createHarness({ migrationFails: true });
  try {
    const oldHost = await fs.readFile(harness.paths.nginxHost, "utf8");
    const oldAdminUnit = await fs.readFile(harness.paths.adminUnit, "utf8");
    const oldContentUnit = await fs.readFile(harness.paths.contentUnit, "utf8");
    const oldContentEnvironment = await fs.readFile(harness.paths.contentEnvFile, "utf8");
    await assert.rejects(deployRelease({ deploySha: DEPLOY_SHA, log: (message) => harness.logs.push(message), paths: harness.paths, repoUrl: REPO_URL, run: harness.run }), /migration failed/);
    assert.equal(path.resolve(await fs.readlink(harness.paths.currentLink)), path.resolve(harness.previousRelease));
    assert.equal(await fs.readFile(harness.paths.adminUnit, "utf8"), oldAdminUnit);
    assert.equal(await fs.readFile(harness.paths.contentUnit, "utf8"), oldContentUnit);
    assert.equal(await fs.readFile(harness.paths.nginxHost, "utf8"), oldHost);
    assert.equal(harness.serviceState.active.get(ADMIN_SERVICE), true);
    assert.equal(harness.serviceState.active.get(CONTENT_SERVICE), false);
    assert.equal(harness.serviceState.enabled.get(ADMIN_SERVICE), true);
    assert.equal(await fs.readFile(harness.paths.contentEnvFile, "utf8"), oldContentEnvironment);
    assert.equal(harness.serviceState.enabled.get(CONTENT_SERVICE), false);
    assert.equal(harness.commands.some(({ args }) => args.includes("migrate:record-index:recover")), false);
    assert.match(harness.logs.join("\n"), /data state requires operator review/i);
    const legacyPermissionIndex = commandIndex(harness.commands, ({ command, args }) =>
      command === "chown" && args.join(" ") === `-R htmlworkbench:htmlworkbench ${harness.paths.dataDir}`
    );
    const restoredAdminStartIndex = harness.commands.findLastIndex(({ command, args }) =>
      command === "systemctl" && args[0] === "start" && args.includes(ADMIN_SERVICE)
    );
    assert.ok(legacyPermissionIndex !== -1, "legacy data ownership is restored with the legacy unit");
    assert.ok(legacyPermissionIndex < restoredAdminStartIndex, "legacy ownership is restored before the old admin starts");
  } finally { await harness.cleanup(); }
});

test("migration failure rolls back when the content unit did not previously exist", async () => {
  const harness = await createHarness({ migrationFails: true, contentUnitExists: false, contentActive: false, contentEnabled: false });
  try {
    await assert.rejects(
      deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run }),
      /migration failed/
    );
    assert.equal(await exists(harness.paths.contentUnit), false);
    assert.equal(harness.serviceState.active.get(ADMIN_SERVICE), true);
    assert.equal(harness.serviceState.active.get(CONTENT_SERVICE), false);
    assert.equal(harness.serviceState.enabled.get(CONTENT_SERVICE), false);
  } finally { await harness.cleanup(); }
});
test("post-start Nginx failure restores the prior release, files, service state, and admin health", async () => {
  const harness = await createHarness({ postStartNginxFails: true, adminActive: true, adminEnabled: true, contentActive: true, contentEnabled: false });
  try {
    const snapshots = new Map();
    for (const filePath of [harness.paths.adminUnit, harness.paths.contentUnit, harness.paths.nginxHost, harness.paths.adminSnippet, harness.paths.contentSnippet, harness.paths.contentEnvFile]) {
      snapshots.set(filePath, await fs.readFile(filePath, "utf8"));
    }
    await assert.rejects(deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run }), /invalid final nginx/);
    assert.equal(path.resolve(harness.activationObserved.currentTarget), path.resolve(harness.paths.releaseDir(DEPLOY_SHA)));
    assert.match(harness.activationObserved.adminUnit, /\/opt\/html-workbench\/current\/server\.js/);
    assert.match(harness.activationObserved.contentUnit, /\/opt\/html-workbench\/current\/server\.js/);
    assert.match(harness.activationObserved.nginxHost, new RegExp(MANAGED_HOST_MARKER));
    assert.notEqual(harness.activationObserved.adminSnippet, snapshots.get(harness.paths.adminSnippet));
    assert.notEqual(harness.activationObserved.contentSnippet, snapshots.get(harness.paths.contentSnippet));
    assert.equal(harness.activationObserved.adminActive, true);
    assert.equal(harness.activationObserved.contentActive, true);
    assert.equal(harness.activationObserved.adminEnabled, true);
    assert.equal(harness.activationObserved.contentEnabled, true);
    assert.equal(path.resolve(await fs.readlink(harness.paths.currentLink)), path.resolve(harness.previousRelease));
    for (const [filePath, contents] of snapshots) assert.equal(await fs.readFile(filePath, "utf8"), contents);
    assert.equal(harness.serviceState.active.get(ADMIN_SERVICE), true);
    assert.equal(harness.serviceState.active.get(CONTENT_SERVICE), true);
    assert.equal(harness.serviceState.enabled.get(ADMIN_SERVICE), true);
    assert.equal(harness.serviceState.enabled.get(CONTENT_SERVICE), false);
    const finalNginxFailureIndex = harness.commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.command === "nginx" && entry.args[0] === "-t")
      .at(1).index;
    assert.ok(harness.commands.slice(finalNginxFailureIndex + 1).some(({ command, args }) =>
      command === "curl"
      && args.includes("Host: ho.wekki.fun")
      && args.includes("http://127.0.0.1:3000/healthz")
    ));
    assert.ok(await exists(harness.paths.releaseDir(DEPLOY_SHA)));
  } finally { await harness.cleanup(); }
});
test("effective environment parsing honors quotes, duplicate last-wins values, and empty credentials", () => {
  const parsed = parseSystemdEnvironmentFile(`HTML_WORKBENCH_PASSWORD=first
HTML_WORKBENCH_PASSWORD="last value"
HTML_WORKBENCH_AUTH_SECRET='quoted auth'
HTML_WORKBENCH_DOWNLOAD_PASSWORD=""
HTML_WORKBENCH_CURSOR_SECRET='cursor value'
HTML_WORKBENCH_DATA_DIR=/var/lib/html-workbench
HTML_WORKBENCH_ADMIN_ORIGIN=https://ho.wekki.fun
HTML_WORKBENCH_PUBLIC_ORIGIN=https://page.wekki.fun
`);
  assert.equal(parsed.HTML_WORKBENCH_PASSWORD, "last value");
  assert.equal(parsed.HTML_WORKBENCH_AUTH_SECRET, "quoted auth");
  assert.equal(parsed.HTML_WORKBENCH_DOWNLOAD_PASSWORD, "");
  assert.throws(() => validateEffectiveEnvironment(parsed), /HTML_WORKBENCH_DOWNLOAD_PASSWORD/);
});

test("deployment rejects an effectively empty quoted credential before stopping services", async () => {
  const harness = await createHarness({
    environmentFile: validEnvironmentFile().replace('HTML_WORKBENCH_DOWNLOAD_PASSWORD="885688"', 'HTML_WORKBENCH_DOWNLOAD_PASSWORD=""')
  });
  try {
    const oldContentEnvironment = await fs.readFile(harness.paths.contentEnvFile, "utf8");
    await assert.rejects(
      deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run }),
      /HTML_WORKBENCH_DOWNLOAD_PASSWORD/
    );
    assert.equal(harness.commands.some(({ command, args }) => command === "systemctl" && args[0] === "stop"), false);
    assert.equal(await fs.readFile(harness.paths.contentEnvFile, "utf8"), oldContentEnvironment);
  } finally { await harness.cleanup(); }
});
test("production environment accepts explicitly configured 885688 credentials", () => {
  const parsed = parseSystemdEnvironmentFile(validEnvironmentFile());
  parsed.HTML_WORKBENCH_PASSWORD = "885688";
  parsed.HTML_WORKBENCH_DOWNLOAD_PASSWORD = "885688";
  assert.equal(validateEffectiveEnvironment(parsed), true);
});

test("production environment requires an independent strong auth signing secret", () => {
  const parsed = parseSystemdEnvironmentFile(validEnvironmentFile());
  for (const secret of ["", "change-this-auth-secret", "885688", "short-secret", "a".repeat(64)]) {
    parsed.HTML_WORKBENCH_AUTH_SECRET = secret;
    assert.throws(
      () => validateEffectiveEnvironment(parsed),
      /HTML_WORKBENCH_AUTH_SECRET/
    );
  }
  parsed.HTML_WORKBENCH_AUTH_SECRET = "oJPyDUkzBK7U78fZp1yJhMUJ8iL8dGeK6cX4HnJrT40";
  assert.equal(validateEffectiveEnvironment(parsed), true);
});

test("production environment rejects missing credentials instead of silently falling back", () => {
  const parsed = parseSystemdEnvironmentFile(validEnvironmentFile());
  delete parsed.HTML_WORKBENCH_PASSWORD;
  assert.throws(() => validateEffectiveEnvironment(parsed), /HTML_WORKBENCH_PASSWORD/);
});

test("content validation profile is non-secret and rejects leaked management credentials", () => {
  const contentEnvironment = {
    HTML_WORKBENCH_DATA_DIR: "/var/lib/html-workbench",
    HTML_WORKBENCH_ADMIN_ORIGIN: "https://ho.wekki.fun",
    HTML_WORKBENCH_PUBLIC_ORIGIN: "https://page.wekki.fun"
  };
  assert.equal(validateEffectiveEnvironment(contentEnvironment, { profile: "content-host" }), true);
  assert.throws(
    () => validateEffectiveEnvironment({
      ...contentEnvironment,
      HTML_WORKBENCH_AUTH_SECRET: "leaked"
    }, { profile: "content-host" }),
    /must not receive HTML_WORKBENCH_AUTH_SECRET/
  );
});

for (const [name, option] of [
  ["LoadState", "systemctlShowFails"],
  ["active state", "systemctlIsActiveFails"],
  ["enabled state", "systemctlIsEnabledFails"]
]) {
  test(`systemctl ${name} control-plane failure aborts before stop or migration`, async () => {
    const harness = await createHarness({ [option]: true });
    try {
      await assert.rejects(
        deployRelease({ deploySha: DEPLOY_SHA, paths: harness.paths, repoUrl: REPO_URL, run: harness.run }),
        /Failed to connect to bus/
      );
      assert.equal(harness.serviceState.active.get(ADMIN_SERVICE), true);
      assert.equal(harness.commands.some(({ command, args }) => command === "systemctl" && args[0] === "stop"), false);
      assert.equal(harness.commands.some(({ command, args }) => command === "systemd-run" && args.includes("migrate:record-index")), false);
    } finally { await harness.cleanup(); }
  });
}

test("systemd units run the atomically activated current release", async () => {
  const [admin, content] = await Promise.all([fs.readFile("deploy/self-host/html-workbench.service", "utf8"), fs.readFile("deploy/self-host/html-workbench-content.service", "utf8")]);
  for (const service of [admin, content]) {
    assert.match(service, /^WorkingDirectory=\/opt\/html-workbench\/current$/m);
    assert.match(service, /\/opt\/html-workbench\/current\/server\.js/);
  }
  assert.match(admin, /^User=htmlworkbench-admin$/m);
  assert.match(admin, /^Group=htmlworkbench-admin$/m);
  assert.match(admin, /^SupplementaryGroups=htmlworkbench-data$/m);
  assert.match(content, /^User=htmlworkbench-content$/m);
  assert.match(content, /^Group=htmlworkbench-content$/m);
  assert.match(content, /^SupplementaryGroups=htmlworkbench-data$/m);
  assert.doesNotMatch(content, /^User=htmlworkbench-admin$/m);
  assert.doesNotMatch(content, /^Group=htmlworkbench-admin$/m);
  assert.match(admin, /^EnvironmentFile=\/etc\/html-workbench\.env$/m);
  assert.match(
    admin,
    /^ExecStartPre=\/usr\/bin\/node \/opt\/html-workbench\/current\/deploy\/self-host\/validate-env\.mjs$/m
  );
  assert.match(content, /^EnvironmentFile=\/etc\/html-workbench-content\.env$/m);
  assert.match(
    content,
    /^ExecStartPre=\/usr\/bin\/node \/opt\/html-workbench\/current\/deploy\/self-host\/validate-env\.mjs --profile content-host$/m
  );
  assert.match(admin, /^Environment=HTML_WORKBENCH_ROLE=admin$/m);
  assert.match(admin, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.match(admin, /^Environment=PORT=3000$/m);
  assert.match(content, /^Environment=HTML_WORKBENCH_ROLE=content$/m);
  assert.match(content, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.match(content, /^Environment=PORT=3001$/m);
  assert.match(content, /^ProtectSystem=strict$/m);
  assert.match(content, /^ReadOnlyPaths=\/var\/lib\/html-workbench$/m);
  assert.doesNotMatch(content, /^ReadWritePaths=/m);
  assert.match(admin, /^UMask=0027$/m);
  assert.match(content, /^UMask=0077$/m);
  assert.doesNotMatch(content, /HTML_WORKBENCH_(?:PASSWORD|AUTH_SECRET|DOWNLOAD_PASSWORD|CURSOR_SECRET)/);
});

test("self-hosted content environment template contains no management credentials", async () => {
  const template = await fs.readFile("deploy/self-host/html-workbench-content.env.example", "utf8");
  for (const name of [
    "HTML_WORKBENCH_PASSWORD",
    "HTML_WORKBENCH_AUTH_SECRET",
    "HTML_WORKBENCH_DOWNLOAD_PASSWORD",
    "HTML_WORKBENCH_CURSOR_SECRET"
  ]) assert.doesNotMatch(template, new RegExp(name));
  assert.match(template, /HTML_WORKBENCH_DATA_DIR=\/var\/lib\/html-workbench/);
});

test("workflow pins the triggering SHA and an out-of-band SSH host key", async () => {
  const workflow = await fs.readFile(".github/workflows/deploy-self-host.yml", "utf8");
  assert.match(workflow, /DEPLOY_SHA:.*github\.sha/);
  assert.match(workflow, /SERVER_HOST_KEY/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /UserKnownHostsFile=/);
  assert.match(workflow, /ssh-keygen -lf/);
  assert.match(workflow, /scp -P "\$SERVER_PORT"/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.doesNotMatch(workflow, /git .*reset --hard/);
  assert.doesNotMatch(workflow, /Skipping self-hosted deployment/);
});

test("Vercel routes /healthz to the health API", async () => {
  const config = JSON.parse(await fs.readFile("vercel.json", "utf8"));
  assert.ok(config.rewrites.some((rewrite) => rewrite.source === "/healthz" && rewrite.destination === "/api/health"));
  await fs.access("api/health.mjs");
});
