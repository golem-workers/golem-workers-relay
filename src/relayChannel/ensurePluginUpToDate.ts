import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import JSON5 from "json5";

export const RELAY_CHANNEL_PACKAGE = "@golemworkers/relay-channel";
const PLUGIN_ID = "relay-channel";
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export type PluginUpdateDeps = {
  exec: (command: string, args: string[], timeoutMs?: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
};
export type PluginUpdateResult = { status: "unchanged" | "updated" | "deferred"; version?: string; reason?: string };

export function comparePluginVersions(left: string, right: string): number {
  if (!STABLE_VERSION.test(left) || !STABLE_VERSION.test(right)) throw new Error("PLUGIN_VERSION_INVALID");
  const a = left.split(".").map(BigInt), b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function installedPlugin(value: unknown): Row | undefined {
  const plugins = row(value).plugins;
  return Array.isArray(plugins) ? plugins.map(row).find(p => p.id === PLUGIN_ID) : undefined;
}
function protectedConfig(value: unknown): Row {
  const config = structuredClone(row(value));
  // Old hosts track install metadata in JSON; newer hosts own it in SQLite.
  const plugins = row(config.plugins);
  delete plugins.installs;
  return config;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(row(value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
  return JSON.stringify(value);
}

/** Caller holds the shared install -> model -> owner locks through activation.
 * Use the host's transactional lifecycle, never uninstall, rewrite config, grant
 * capabilities or enable a plugin. npm/Gateway failures are not startup failures.
 */
export async function ensureRelayChannelPluginUpToDate(
  input: { openclawConfigPath: string }, deps: PluginUpdateDeps,
): Promise<PluginUpdateResult> {
  const configPath = input.openclawConfigPath;
  const receiptPath = configPath + ".relay-channel-update.json";
  const readConfig = async (): Promise<Row> => protectedConfig(JSON5.parse(await fs.readFile(configPath, "utf8")));
  const before = await readConfig();
  const configSha256 = createHash("sha256").update(canonical(before)).digest("hex");
  const json = async (command: string, args: string[], timeout?: number): Promise<unknown> => JSON.parse(await deps.exec(command, args, timeout)) as unknown;
  const rpc = (method: string): Promise<unknown> => json("openclaw", ["gateway", "call", method, "--json"], 15_000);
  const plugin = installedPlugin(await json("openclaw", ["plugins", "list", "--json"], 30_000));
  const trust = row(plugin?.trust);
  if (!plugin || plugin.enabled !== true || trust.installSource !== "npm" ||
      typeof trust.installSpec !== "string" || !/^@golemworkers\/relay-channel(?:@(?:latest|\d+\.\d+\.\d+))?$/.test(trust.installSpec)) {
    return { status: "deferred", reason: "not-enabled-managed-npm-install" };
  }
  const current = plugin.version;
  if (typeof current !== "string" || !STABLE_VERSION.test(current)) return { status: "deferred", reason: "non-stable-install" };
  let receipt: Row = {};
  try { receipt = row(JSON.parse(await fs.readFile(receiptPath, "utf8")) as unknown); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const save = async (phase: string, version: string): Promise<void> => {
    const temporary = receiptPath + ".tmp";
    const handle = await fs.open(temporary, "w", 0o600);
    try { await handle.writeFile(JSON.stringify({ phase, version, configSha256, updatedAt: new Date().toISOString() }) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, receiptPath);
    const directory = await fs.open(path.dirname(receiptPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    receipt = { phase, version, configSha256 };
  };
  // Recover an accepted install/activation before looking for another release.
  const pending = receipt.phase === "installing" || receipt.phase === "installed" || receipt.phase === "restarting";
  if (pending && receipt.configSha256 !== configSha256) throw new Error("PLUGIN_CONFIG_PRESERVATION_FAILED");
  const desired: unknown = pending ? receipt.version : await json("npm", ["view", `${RELAY_CHANNEL_PACKAGE}@latest`, "version", "--json", "--registry=https://registry.npmjs.org"], 30_000);
  if (typeof desired !== "string" || !STABLE_VERSION.test(desired)) throw new Error("PLUGIN_RELEASE_INVALID");
  if (!pending && comparePluginVersions(current, desired) >= 0) return { status: "unchanged", version: current };
  if (pending && current !== desired) throw new Error("PLUGIN_UPDATE_OUTCOME_UNRESOLVED");
  if (!pending) {
    const preflight = row(await rpc("gateway.restart.preflight"));
    if (preflight.safe !== true || row(preflight.counts).totalActive !== 0) return { status: "deferred", reason: "gateway-busy" };
    // Compatibility, install policy and capability consent remain host-owned.
    // No --accept-capabilities/--force, no --all, and stdin is never interactive.
    await deps.exec("openclaw", ["plugins", "update", `${RELAY_CHANNEL_PACKAGE}@${desired}`, "--dry-run"], 120_000);
    if (!isDeepStrictEqual(before, await readConfig())) throw new Error("PLUGIN_CONFIG_CHANGED_BEFORE_UPDATE");
    await save("installing", desired);
    await deps.exec("openclaw", ["plugins", "update", `${RELAY_CHANNEL_PACKAGE}@${desired}`], 600_000);
    const updated = installedPlugin(await json("openclaw", ["plugins", "list", "--json"], 30_000));
    if (updated?.version !== desired) throw new Error("PLUGIN_INSTALLED_VERSION_UNVERIFIED");
    await save("installed", desired);
  }
  const verify = async (): Promise<boolean> => {
    if (!isDeepStrictEqual(before, await readConfig())) throw new Error("PLUGIN_CONFIG_PRESERVATION_FAILED");
    const live = installedPlugin(await rpc("plugins.list"));
    if (live?.version !== desired || row(live.runtime).state !== "active") return false;
    return row(await rpc("health")).ok === true;
  };
  const tryVerify = async (): Promise<boolean> => {
    try { return await verify(); }
    catch (err) {
      if (err instanceof Error && err.message === "PLUGIN_CONFIG_PRESERVATION_FAILED") throw err;
      return false;
    }
  };
  if (!await tryVerify()) {
    // The host schedules an idle/draining restart; never bypass deferral/force.
    // Persist before requesting so a lost acknowledgement cannot cause a storm.
    if (receipt.phase !== "restarting") {
      await save("restarting", desired);
      await deps.exec("openclaw", ["gateway", "restart", "--safe", "--json"], 30_000);
    }
    let ready = false;
    for (let i = 0; i < 12; i++) {
      await deps.sleep(5_000);
      if (await tryVerify()) { ready = true; break; }
    }
    if (!ready) throw new Error("PLUGIN_RUNTIME_ACTIVATION_UNVERIFIED");
  }
  await save("complete", desired);
  return { status: "updated", version: desired };
}
