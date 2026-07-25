import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildManagedHostConfig } from "./nginx-config.mjs";

const ADMIN_SERVICE = "html-workbench.service";
const CONTENT_SERVICE = "html-workbench-content.service";
const SERVICE_NAMES = [ADMIN_SERVICE, CONTENT_SERVICE];
const DEPLOY_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function rooted(rootDir, absolutePath) {
  if (rootDir === path.parse(rootDir).root) return absolutePath;
  return path.join(rootDir, ...absolutePath.split("/").filter(Boolean));
}

export function createDeploymentPaths({ rootDir = "/", appDir = "/opt/html-workbench" } = {}) {
  const mappedAppDir = rooted(rootDir, appDir);
  return {
    rootDir,
    appDir: mappedAppDir,
    releasesDir: path.join(mappedAppDir, "releases"),
    currentLink: path.join(mappedAppDir, "current"),
    dataDir: rooted(rootDir, "/var/lib/html-workbench"),
    envFile: rooted(rootDir, "/etc/html-workbench.env"),
    adminUnit: rooted(rootDir, "/etc/systemd/system/html-workbench.service"),
    contentUnit: rooted(rootDir, "/etc/systemd/system/html-workbench-content.service"),
    nginxHost: rooted(rootDir, "/etc/nginx/conf.d/ho.wekki.fun.conf"),
    adminSnippet: rooted(rootDir, "/etc/nginx/snippets/html-workbench-admin-routes.conf"),
    contentSnippet: rooted(rootDir, "/etc/nginx/snippets/html-workbench-content-routes.conf"),
    releaseDir: (sha) => path.join(mappedAppDir, "releases", sha)
  };
}

function defaultRun(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function checked(run, command, args = [], options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${command} ${args.join(" ")} failed with status ${result.code}`);
  }
  return result;
}

async function fileExists(filePath) {
  try { await fs.lstat(filePath); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return { exists: true, contents: await fs.readFile(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function replaceFile(filePath, contents, mode = 0o644) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.html-workbench-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents, { mode });
  if (process.platform === "win32" && await fileExists(filePath)) await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, mode);
}

async function restoreFile(filePath, snapshot) {
  if (!snapshot.exists) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await replaceFile(filePath, snapshot.contents, snapshot.mode);
}

async function readLink(linkPath) {
  try { return await fs.readlink(linkPath); } catch (error) {
    if (error.code === "ENOENT" || error.code === "EINVAL") return null;
    throw error;
  }
}

async function activateLink(linkPath, target) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  const temporary = `${linkPath}.next-${process.pid}-${Date.now()}`;
  await fs.symlink(target, temporary, process.platform === "win32" ? "junction" : "dir");
  if (process.platform === "win32" && await fileExists(linkPath)) await fs.rm(linkPath, { force: true });
  await fs.rename(temporary, linkPath);
}

async function restoreLink(linkPath, target) {
  if (target == null) {
    await fs.rm(linkPath, { force: true });
    return;
  }
  await activateLink(linkPath, target);
}

async function serviceLoaded(run, service) {
  const result = await run("systemctl", ["show", "--property=LoadState", "--value", service]);
  const state = String(result.stdout).trim();
  if (state === "not-found") return false;
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `systemctl show failed with status ${result.code}`);
  }
  if (!state) throw new Error(`systemctl show returned no LoadState for ${service}`);
  return true;
}

async function serviceFlag(run, operation, service) {
  const result = await run("systemctl", [operation, service]);
  const state = String(result.stdout).trim().toLowerCase();
  const activeStates = new Set(["active", "reloading"]);
  const enabledStates = new Set(["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"]);
  const disabledStates = new Set([
    "disabled", "disabled-runtime", "masked", "masked-runtime", "static",
    "indirect", "generated", "transient", "not-found"
  ]);

  if (operation === "is-active") {
    if (result.code === 0 && activeStates.has(state)) return true;
    if (result.code === 3 && (state === "inactive" || state === "failed")) return false;
    if (result.code === 4 && (state === "not-found" || state === "unknown")) return false;
  } else if (operation === "is-enabled") {
    if (enabledStates.has(state) && result.code === 0) return true;
    if (disabledStates.has(state)) return false;
  }

  const detail = String(result.stderr || result.stdout || "").trim();
  throw new Error(detail || `systemctl ${operation} returned unexpected state for ${service}`);
}

async function captureServiceState(run) {
  const state = new Map();
  for (const service of SERVICE_NAMES) {
    state.set(service, {
      loaded: await serviceLoaded(run, service),
      active: await serviceFlag(run, "is-active", service),
      enabled: await serviceFlag(run, "is-enabled", service)
    });
  }
  return state;
}

async function restoreEnableState(run, state, migrationFailed) {
  for (const service of SERVICE_NAMES) {
    const expected = service === CONTENT_SERVICE && migrationFailed ? false : state.get(service).enabled;
    await run("systemctl", [expected ? "enable" : "disable", service]);
    const actual = await serviceFlag(run, "is-enabled", service);
    if (actual !== expected) throw new Error(`Could not restore ${service} enabled state to ${expected}`);
  }
}

async function restoreActiveState(run, state, migrationFailed) {
  for (const service of SERVICE_NAMES) {
    const previous = state.get(service);
    const expected = service === CONTENT_SERVICE && migrationFailed ? false : previous.active;
    await run("systemctl", [expected ? "start" : "stop", service]);
    const actual = await serviceFlag(run, "is-active", service);
    if (actual !== expected) throw new Error(`Could not restore ${service} active state to ${expected}`);
  }
}

async function stageRelease({ deploySha, paths, repoUrl, run }) {
  const releaseDir = paths.releaseDir(deploySha);
  const marker = path.join(releaseDir, ".html-workbench-release-ready");
  if (await fileExists(marker)) {
    const markedSha = (await fs.readFile(marker, "utf8")).trim();
    if (markedSha !== deploySha) throw new Error(`Release marker for ${deploySha} contains ${markedSha}`);
    return releaseDir;
  }

  const stagingDir = path.join(paths.releasesDir, `.staging-${deploySha}-${process.pid}`);
  await fs.rm(stagingDir, { force: true, recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    await checked(run, "git", ["init"], { cwd: stagingDir });
    await checked(run, "git", ["remote", "add", "origin", repoUrl], { cwd: stagingDir });
    await checked(run, "git", ["fetch", "--depth=1", "origin", deploySha], { cwd: stagingDir });
    await checked(run, "git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: stagingDir });
    const resolved = await checked(run, "git", ["rev-parse", "HEAD"], { cwd: stagingDir });
    if (String(resolved.stdout).trim().toLowerCase() !== deploySha.toLowerCase()) {
      throw new Error(`Fetched release SHA ${String(resolved.stdout).trim()} does not match DEPLOY_SHA ${deploySha}`);
    }
    await checked(run, "npm", ["ci", "--omit=dev"], { cwd: stagingDir, capture: false });
    await fs.writeFile(path.join(stagingDir, ".html-workbench-release-ready"), `${deploySha}\n`);
    try {
      await fs.rename(stagingDir, releaseDir);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      if (!await fileExists(marker)) throw error;
      await fs.rm(stagingDir, { force: true, recursive: true });
    }
    return releaseDir;
  } catch (error) {
    await fs.rm(stagingDir, { force: true, recursive: true });
    throw error;
  }
}

async function ensureHostPrerequisites({ paths, releaseDir, run }) {
  await fs.mkdir(paths.releasesDir, { recursive: true });
  await fs.mkdir(paths.dataDir, { recursive: true });
  if ((await run("id", ["htmlworkbench"])).code !== 0) {
    await checked(run, "useradd", ["--system", "--home", "/opt/html-workbench", "--shell", "/usr/sbin/nologin", "htmlworkbench"]);
  }
  await checked(run, "chown", ["-R", "htmlworkbench:htmlworkbench", paths.dataDir]);
  if (!await fileExists(paths.envFile)) {
    await fs.mkdir(path.dirname(paths.envFile), { recursive: true });
    await fs.copyFile(path.join(releaseDir, "deploy/self-host/html-workbench.env.example"), paths.envFile);
  }
  await checked(run, "chown", ["root:htmlworkbench", paths.envFile]);
  await checked(run, "chmod", ["640", paths.envFile]);
}

async function validateEnvironment({ paths, releaseDir, run }) {
  await checked(run, "systemd-run", [
    "--quiet", "--wait", "--collect", "--pipe",
    `--unit=html-workbench-env-preflight-${Date.now()}-${process.pid}`,
    "--property=User=htmlworkbench",
    "--property=Group=htmlworkbench",
    `--property=EnvironmentFile=${paths.envFile}`,
    "/usr/bin/node", path.join(releaseDir, "deploy/self-host/validate-env.mjs")
  ]);
}

async function stopLoadedServices(run, serviceState) {
  const loaded = SERVICE_NAMES.filter((service) => serviceState.get(service).loaded);
  if (loaded.length) await checked(run, "systemctl", ["stop", ...loaded]);
}

async function migrate({ paths, releaseDir, run }) {
  await checked(run, "systemd-run", [
    "--quiet", "--wait", "--collect", "--pipe",
    `--unit=html-workbench-record-index-migration-${Date.now()}-${process.pid}`,
    "--property=User=htmlworkbench",
    "--property=Group=htmlworkbench",
    `--property=WorkingDirectory=${releaseDir}`,
    "--property=Environment=NODE_ENV=production",
    `--property=EnvironmentFile=${paths.envFile}`,
    "/usr/bin/npm", "run", "migrate:record-index"
  ]);
}

async function checkHealth(run, service, port, host) {
  let lastResult = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastResult = await run("curl", ["--fail", "--silent", "--show-error", "--header", `Host: ${host}`, `http://127.0.0.1:${port}/healthz`]);
    if (lastResult.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${service} readiness check failed: ${String(lastResult?.stderr || "unknown error").trim()}`);
}

async function transactionSnapshot(paths) {
  const files = new Map();
  for (const filePath of [paths.adminUnit, paths.contentUnit, paths.nginxHost, paths.adminSnippet, paths.contentSnippet]) {
    files.set(filePath, await snapshotFile(filePath));
  }
  return { files, currentTarget: await readLink(paths.currentLink) };
}

async function restoreTransaction({ paths, run, serviceState, snapshot, migrationFailed, log }) {
  for (const service of SERVICE_NAMES) await run("systemctl", ["stop", service]);
  await restoreEnableState(run, serviceState, migrationFailed);
  await restoreLink(paths.currentLink, snapshot.currentTarget);
  for (const [filePath, fileSnapshot] of snapshot.files) await restoreFile(filePath, fileSnapshot);
  await checked(run, "systemctl", ["daemon-reload"]);
  await checked(run, "nginx", ["-t"]);
  await checked(run, "systemctl", ["reload", "nginx"]);
  await restoreActiveState(run, serviceState, migrationFailed);
  if (serviceState.get(ADMIN_SERVICE).active) {
    await checkHealth(run, ADMIN_SERVICE, 3000, "ho.wekki.fun");
  }
  log("Rollback restored the previous release and managed configuration; data state requires operator review before retrying.");
  if (migrationFailed) log("Migration failed: content remains stopped and disabled. Never run explicit lock recovery without operator confirmation that no migration is active.");
}

export async function deployRelease({
  deploySha,
  repoUrl = "https://github.com/wekkizhang-creator/HTMLWorkbench.git",
  paths = createDeploymentPaths(),
  run = defaultRun,
  log = console.log
}) {
  if (!/^[0-9a-f]{40}$/i.test(deploySha || "")) throw new Error("DEPLOY_SHA must be a full 40-character Git commit SHA");

  await fs.mkdir(paths.releasesDir, { recursive: true });
  const releaseDir = await stageRelease({ deploySha, paths, repoUrl, run });
  await ensureHostPrerequisites({ paths, releaseDir, run });
  await validateEnvironment({ paths, releaseDir, run });

  const unitSources = {
    [paths.adminUnit]: await fs.readFile(path.join(releaseDir, "deploy/self-host/html-workbench.service")),
    [paths.contentUnit]: await fs.readFile(path.join(releaseDir, "deploy/self-host/html-workbench-content.service"))
  };
  const adminRoutes = await fs.readFile(path.join(releaseDir, "deploy/self-host/nginx-admin-routes.conf"));
  const contentRoutes = await fs.readFile(path.join(releaseDir, "deploy/self-host/nginx-content-routes.conf"));
  const existingHost = await fileExists(paths.nginxHost) ? await fs.readFile(paths.nginxHost, "utf8") : null;
  const hostCandidate = buildManagedHostConfig(existingHost);
  const snapshot = await transactionSnapshot(paths);
  const serviceState = await captureServiceState(run);
  let stopped = false;
  let migrationFailed = false;

  try {
    stopped = true;
    await stopLoadedServices(run, serviceState);
    try {
      await migrate({ paths, releaseDir, run });
    } catch (error) {
      migrationFailed = true;
      throw error;
    }

    await activateLink(paths.currentLink, releaseDir);
    await replaceFile(paths.adminUnit, unitSources[paths.adminUnit], 0o644);
    await replaceFile(paths.contentUnit, unitSources[paths.contentUnit], 0o644);
    await replaceFile(paths.adminSnippet, adminRoutes, 0o644);
    await replaceFile(paths.contentSnippet, contentRoutes, 0o644);
    if (hostCandidate !== existingHost) await replaceFile(paths.nginxHost, hostCandidate, 0o644);

    await checked(run, "nginx", ["-t"]);
    await checked(run, "systemctl", ["daemon-reload"]);
    await checked(run, "systemctl", ["enable", ADMIN_SERVICE, CONTENT_SERVICE]);
    await checked(run, "systemctl", ["restart", ADMIN_SERVICE, CONTENT_SERVICE]);
    await checkHealth(run, ADMIN_SERVICE, 3000, "ho.wekki.fun");
    await checkHealth(run, CONTENT_SERVICE, 3001, "page.wekki.fun");
    await checked(run, "nginx", ["-t"]);
    await checked(run, "systemctl", ["reload", "nginx"]);
    log(`HTMLWorkbench release ${deploySha} deployed successfully.`);
    return { deploySha, releaseDir };
  } catch (error) {
    if (stopped) {
      try {
        await restoreTransaction({ paths, run, serviceState, snapshot, migrationFailed, log });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Deployment failed and rollback was incomplete: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

async function main() {
  await deployRelease({
    deploySha: process.env.DEPLOY_SHA,
    repoUrl: process.env.REPO_URL || "https://github.com/wekkizhang-creator/HTMLWorkbench.git",
    paths: createDeploymentPaths({ appDir: process.env.APP_DIR || "/opt/html-workbench" })
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof AggregateError ? error.errors.map((item) => item.message).join("\n") : error.message);
    process.exitCode = 1;
  });
}
