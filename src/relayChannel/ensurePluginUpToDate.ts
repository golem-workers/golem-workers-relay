import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import JSON5 from "json5";
import { logger } from "../logger.js";
import type { RelayConfig } from "../config/env.js";

const execFile = promisify(execFileCallback);
const RELAY_CHANNEL_PLUGIN_ID = "relay-channel";
const DEFAULT_GATEWAY_SERVICE_NAME = "openclaw-gateway.service";
const GATEWAY_RESTART_CHECK_ATTEMPTS = 30;
const GATEWAY_RESTART_CHECK_DELAY_MS = 500;

type RelayChannelPluginConfig = RelayConfig["relayChannel"]["plugin"];

type ExecOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type ExecRunner = (
  command: string,
  args: string[],
  options?: ExecOptions
) => Promise<{ stdout: string; stderr: string }>;

type Deps = {
  exec: ExecRunner;
  sleep: (ms: number) => Promise<void>;
};

type PluginInstallState = {
  installPath: string | null;
  version: string | null;
  enabled: boolean;
  entryConfig: Record<string, unknown> | null;
  channelConfig: Record<string, unknown> | null;
};

const defaultDeps: Deps = {
  exec: (command, args, options) =>
    execFile(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      maxBuffer: 10 * 1024 * 1024,
    }).then(({ stdout, stderr }) => ({
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    })),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function ensureRelayChannelPluginUpToDate(
  input: {
    openclawConfigPath: string;
    plugin: RelayChannelPluginConfig;
  },
  deps: Partial<Deps> = {}
): Promise<void> {
  if (!input.plugin.autoUpdateEnabled) {
    logger.info("Relay-channel plugin auto-update is disabled");
    return;
  }

  const runtime = { ...defaultDeps, ...deps };
  const plugin = {
    id: RELAY_CHANNEL_PLUGIN_ID,
    repoDir: input.plugin.repoDir,
    repoUrl: input.plugin.repoUrl,
    gitRef: input.plugin.gitRef,
  };

  const desiredVersion = await syncPluginRepoAndReadVersion(plugin, runtime);
  const installed = await readInstalledPluginState(input.openclawConfigPath, plugin.id);

  if (installed.version && comparePluginVersions(installed.version, desiredVersion) >= 0) {
    logger.info(
      {
        event: "relay_channel_plugin_update",
        installedVersion: installed.version,
        desiredVersion,
        installPath: installed.installPath,
        pluginGitRef: plugin.gitRef,
      },
      "Installed relay-channel plugin is already up to date"
    );
    return;
  }

  logger.info(
    {
      event: "relay_channel_plugin_update",
      installedVersion: installed.version,
      desiredVersion,
      installPath: installed.installPath,
      pluginGitRef: plugin.gitRef,
      pluginRepoDir: plugin.repoDir,
    },
    installed.version
      ? "Updating outdated relay-channel plugin before relay startup"
      : "Installing missing relay-channel plugin before relay startup"
  );

  const bundlePath = await buildPluginBundle(plugin, runtime);
  const gatewayServicePresent = await hasGatewayServiceUnit();

  if (gatewayServicePresent) {
    await stopGatewayServiceIfRunning(runtime);
  }

  const desiredChannelConfig = installed.channelConfig ?? installed.entryConfig ?? { accounts: [{ id: "default" }] };
  await writePluginRuntimeConfig({
    configPath: input.openclawConfigPath,
    pluginId: plugin.id,
    enabled: installed.enabled,
    entryConfig: installed.entryConfig ?? desiredChannelConfig,
    channelConfig: desiredChannelConfig,
  });

  await uninstallExistingPlugin(plugin.id, installed.installPath, runtime);
  await runtime.exec("openclaw", ["plugins", "install", bundlePath]);
  await writePluginRuntimeConfig({
    configPath: input.openclawConfigPath,
    pluginId: plugin.id,
    enabled: installed.enabled,
    entryConfig: installed.entryConfig ?? desiredChannelConfig,
    channelConfig: desiredChannelConfig,
  });
  await runtime.exec("openclaw", ["plugins", installed.enabled ? "enable" : "disable", plugin.id]);

  const updated = await readInstalledPluginState(input.openclawConfigPath, plugin.id);
  if (!updated.version || comparePluginVersions(updated.version, desiredVersion) < 0) {
    throw new Error(
      `Relay-channel plugin update did not reach ${desiredVersion}; installed=${updated.version ?? "missing"}`
    );
  }

  if (gatewayServicePresent) {
    await restartGatewayService(runtime);
  }

  logger.info(
    {
      event: "relay_channel_plugin_update",
      installedVersion: updated.version,
      desiredVersion,
      installPath: updated.installPath,
      pluginGitRef: plugin.gitRef,
    },
    "Relay-channel plugin is ready"
  );
}

export function comparePluginVersions(leftRaw: string, rightRaw: string): number {
  const left = leftRaw.trim();
  const right = rightRaw.trim();
  const leftParts = parseNumericVersion(left);
  const rightParts = parseNumericVersion(right);
  if (!leftParts || !rightParts) {
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }
  const max = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < max; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

function parseNumericVersion(version: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(version)) {
    return null;
  }
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

async function syncPluginRepoAndReadVersion(
  plugin: { repoDir: string; repoUrl: string; gitRef: string },
  deps: Deps
): Promise<string> {
  await fs.mkdir(path.dirname(plugin.repoDir), { recursive: true });
  const gitDir = path.join(plugin.repoDir, ".git");
  if (await pathExists(gitDir)) {
    await deps.exec("git", ["fetch", "--prune", "origin", plugin.gitRef], { cwd: plugin.repoDir });
    await deps.exec("git", ["checkout", plugin.gitRef], { cwd: plugin.repoDir });
    await deps.exec("git", ["reset", "--hard", `origin/${plugin.gitRef}`], { cwd: plugin.repoDir });
  } else {
    await fs.rm(plugin.repoDir, { recursive: true, force: true });
    await deps.exec("git", ["clone", "--branch", plugin.gitRef, "--single-branch", plugin.repoUrl, plugin.repoDir]);
  }

  const pkg = parseJsonObject(
    await fs.readFile(path.join(plugin.repoDir, "package.json"), "utf8"),
    `${plugin.repoDir}/package.json`
  );
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error(`Missing relay-channel plugin version in ${plugin.repoDir}/package.json`);
  }
  return version;
}

async function buildPluginBundle(plugin: { id: string; repoDir: string }, deps: Deps): Promise<string> {
  await deps.exec("npm", ["ci", "--include=dev"], { cwd: plugin.repoDir });
  await deps.exec("npm", ["run", "bundle:agent"], { cwd: plugin.repoDir });
  const bundlePath = path.join(plugin.repoDir, ".artifacts", plugin.id, `${plugin.id}-bundle.tgz`);
  if (!(await pathExists(bundlePath))) {
    throw new Error(`Relay-channel bundle was not produced at ${bundlePath}`);
  }
  return bundlePath;
}

async function readInstalledPluginState(configPath: string, pluginId: string): Promise<PluginInstallState> {
  const root = await readOpenclawConfig(configPath);
  const plugins = ensureRecord(root, "plugins");
  const installs = ensureRecord(plugins, "installs");
  const installRecord = asRecord(installs[pluginId]);
  const entries = ensureRecord(plugins, "entries");
  const entryRecord = asRecord(entries[pluginId]);
  const channels = ensureRecord(root, "channels");
  const channelRecord = asRecord(channels[pluginId]);
  const installPath = await resolveInstalledPluginPath(
    typeof installRecord?.installPath === "string" && installRecord.installPath.trim()
      ? installRecord.installPath.trim()
      : null,
    pluginId
  );

  let version: string | null = null;
  if (installPath) {
    try {
      const packagePath = path.join(await fs.realpath(installPath), "package.json");
      const pkg = parseJsonObject(await fs.readFile(packagePath, "utf8"), packagePath);
      version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
    } catch {
      version = null;
    }
  }

  return {
    installPath,
    version,
    enabled: entryRecord?.enabled === true,
    entryConfig: asRecord(entryRecord?.config) ?? null,
    channelConfig: channelRecord,
  };
}

async function resolveInstalledPluginPath(
  installPathFromConfig: string | null,
  pluginId: string
): Promise<string | null> {
  const candidates = [
    installPathFromConfig,
    path.join(os.homedir(), ".openclaw", "extensions", pluginId),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = await resolvePluginInstallDir(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function resolvePluginInstallDir(candidate: string): Promise<string | null> {
  if (!candidate.trim()) {
    return null;
  }

  try {
    const resolved = await fs.realpath(candidate);
    const manifestPath = path.join(resolved, "openclaw.plugin.json");
    const packagePath = path.join(resolved, "package.json");
    if ((await pathExists(manifestPath)) || (await pathExists(packagePath))) {
      return resolved;
    }
  } catch {
    return null;
  }

  return null;
}

async function uninstallExistingPlugin(pluginId: string, installPath: string | null, deps: Deps): Promise<void> {
  try {
    await deps.exec("openclaw", ["plugins", "uninstall", pluginId, "--force"]);
  } catch (error) {
    logger.warn(
      {
        event: "relay_channel_plugin_update",
        pluginId,
        err: error instanceof Error ? error.message : String(error),
      },
      "OpenClaw uninstall failed; continuing with a clean install"
    );
  }

  const removePath =
    installPath && installPath.trim()
      ? installPath.trim()
      : path.join(os.homedir(), ".openclaw", "extensions", pluginId);
  await fs.rm(removePath, { recursive: true, force: true });
}

async function writePluginRuntimeConfig(input: {
  configPath: string;
  pluginId: string;
  enabled: boolean;
  entryConfig: Record<string, unknown>;
  channelConfig: Record<string, unknown>;
}): Promise<void> {
  const root = await readOpenclawConfig(input.configPath);
  const plugins = ensureRecord(root, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const previousEntry = asRecord(entries[input.pluginId]) ?? {};
  entries[input.pluginId] = {
    ...previousEntry,
    enabled: input.enabled,
    config: input.entryConfig,
  };

  const channels = ensureRecord(root, "channels");
  channels[input.pluginId] = input.channelConfig;

  await fs.mkdir(path.dirname(input.configPath), { recursive: true });
  await fs.writeFile(input.configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}

async function readOpenclawConfig(configPath: string): Promise<Record<string, unknown>> {
  if (!(await pathExists(configPath))) {
    return {};
  }
  const raw = await fs.readFile(configPath, "utf8");
  return parseJsonObject(raw, configPath);
}

function parseJsonObject(text: string, filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON5.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected object JSON in ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = asRecord(parent[key]);
  if (current) {
    return current;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function hasGatewayServiceUnit(): Promise<boolean> {
  return pathExists(path.join(os.homedir(), ".config", "systemd", "user", DEFAULT_GATEWAY_SERVICE_NAME));
}

async function stopGatewayServiceIfRunning(deps: Deps): Promise<void> {
  const state = await readGatewayServiceState(deps);
  if (!["active", "activating", "reloading"].includes(state.activeState)) {
    return;
  }
  await execSystemctl(["--user", "stop", DEFAULT_GATEWAY_SERVICE_NAME], deps);
  await waitForGatewayState((current) => current.activeState === "inactive", deps, "stop");
}

async function restartGatewayService(deps: Deps): Promise<void> {
  await execSystemctl(["--user", "reset-failed", DEFAULT_GATEWAY_SERVICE_NAME], deps);
  await execSystemctl(["--user", "restart", DEFAULT_GATEWAY_SERVICE_NAME], deps);
  await waitForGatewayState((current) => current.activeState === "active", deps, "restart");
}

async function waitForGatewayState(
  predicate: (state: { activeState: string; subState: string; result: string | null }) => boolean,
  deps: Deps,
  action: "stop" | "restart"
): Promise<void> {
  for (let attempt = 0; attempt < GATEWAY_RESTART_CHECK_ATTEMPTS; attempt += 1) {
    const state = await readGatewayServiceState(deps);
    if (predicate(state)) {
      return;
    }
    await deps.sleep(GATEWAY_RESTART_CHECK_DELAY_MS);
  }
  const state = await readGatewayServiceState(deps);
  throw new Error(
    `OpenClaw gateway did not ${action} cleanly (activeState=${state.activeState}, subState=${state.subState}, result=${state.result ?? "n/a"})`
  );
}

async function readGatewayServiceState(
  deps: Deps
): Promise<{ activeState: string; subState: string; result: string | null }> {
  const [activeState, subState, result] = await Promise.all([
    execSystemctl(["--user", "show", DEFAULT_GATEWAY_SERVICE_NAME, "-p", "ActiveState", "--value"], deps),
    execSystemctl(["--user", "show", DEFAULT_GATEWAY_SERVICE_NAME, "-p", "SubState", "--value"], deps),
    execSystemctl(["--user", "show", DEFAULT_GATEWAY_SERVICE_NAME, "-p", "Result", "--value"], deps),
  ]);
  return {
    activeState: activeState.trim() || "unknown",
    subState: subState.trim() || "unknown",
    result: result.trim() || null,
  };
}

async function execSystemctl(args: string[], deps: Deps): Promise<string> {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || "/run/user/0";
  const result = await deps.exec("systemctl", args, {
    env: {
      ...process.env,
      HOME: process.env.HOME || "/root",
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
    },
  });
  return result.stdout;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}
