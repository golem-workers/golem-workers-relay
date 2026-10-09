import { verifyInheritedConfigLocks } from "./inheritedConfigLocks.js";
import { withModelFenceLock, readModelFence, isAuthorizedModelSelection } from "./modelFence.js";
import { withManagedRuntimePolicy, commitManagedRuntimePolicy, recheckManagedRuntimePolicy } from "../managed-runtime/runtime-policy.js";
import { MANAGED_RUNTIME_SOURCE_SHA256, type ManagedRuntimePolicy } from "../managed-runtime/policy.generated.js";
export { MANAGED_RUNTIME_SOURCE_SHA256 };
export const managedRuntimeCommitProtocolVersion = 2;
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
const context = new AsyncLocalStorage<{ path: string; active: boolean }>();
export function isConfigMutationPath(file: string) { const scope = context.getStore(); return Boolean(scope?.active && scope.path === path.resolve(file)); }
export function configRevision(text: string) { return createHash("sha256").update(text).digest("hex"); }
import JSON5 from "json5";

function fenceBase(configPath: string) {
  // The production high-water mark must survive .openclaw backup restoration.
  return configPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/owner-fence/openclaw.json" : configPath;
}
export const configCommitProtocolVersion = 2;
export type OwnerFence = { revision: string; active: string[]; revoked: string[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid config object");
  return value as Record<string, unknown>;
}
export function projectOwners(text: string, fence: OwnerFence): string {
  if (!/^[0-9]+$/.test(fence.revision) || [...fence.active, ...fence.revoked].some(id => !/^[1-9][0-9]{0,19}$/.test(id))) throw new Error("Invalid owner fence");
  const config = object(JSON5.parse(text));
  const commands = config.commands === undefined ? {} : object(config.commands);
  const owners: unknown = commands.ownerAllowFrom ?? [];
  if (!Array.isArray(owners) || owners.some(owner => typeof owner !== "string")) throw new Error("Invalid owner list");
  const ownerEntries = owners as string[];
  const revoked = new Set(fence.revoked.filter(id => !fence.active.includes(id)));

  commands.ownerAllowFrom = [...new Set([...ownerEntries.filter((owner: string) => !revoked.has(owner.trim().replace(/^(telegram|tg):/i, "").trim())), ...fence.active.map(id => "telegram:" + id)])];
  config.commands = commands;
  return JSON.stringify(config, null, 2) + "\n";
}
async function atomic(file: string, text: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readOwnerFence(configPath: string): Promise<OwnerFence | null> {
  try { return JSON.parse(await fs.readFile(fenceBase(configPath) + ".owner-fence.json", "utf8")) as OwnerFence; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
// Kernel flock is released on process death; no age-based lock stealing or
// persistent mkdir orphan. Holding stdin keeps only this bounded IO lock alive.
export async function withOwnerFenceLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  configPath = path.resolve(configPath);
  verifyInheritedConfigLocks(fenceBase(configPath));
  if (isConfigMutationPath(configPath)) return operation();
  return withModelFenceLock(configPath, async () => {
  if (verifyInheritedConfigLocks(fenceBase(configPath))) {
    const scope = { path: configPath, active: true };
    try { await recheckManagedRuntimePolicy(configPath); return await context.run(scope, operation); } finally { scope.active = false; }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(fenceBase(configPath)), { recursive: true });
  const lock = spawn("flock", ["-x", "-w", "30", fenceBase(configPath) + ".owner-write.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.once("exit", () => reject(new Error("OWNER_CONFIG_LOCK_UNAVAILABLE")));
      lock.stdout.once("data", () => resolve());
    });
    const scope = { path: configPath, active: true };
    try { await recheckManagedRuntimePolicy(configPath); return await context.run(scope, operation); } finally { scope.active = false; }
  } finally { lock.stdin.end(); }
  });
}
export async function writeOwnerFencedConfig(configPath: string, text: string, incoming?: OwnerFence, options: {
  runtimeInstallActionId?: string;
  operationalPublicPort?: boolean;
  managedRuntimePolicy?: ManagedRuntimePolicy;
  managedRuntimePolicyDigest?: string;
  expectedConfigText?: string | null;
  expectedRevision?: string;
  validate?: (candidate: string) => Promise<void>;
} = {}): Promise<string> {
  if (options.managedRuntimePolicy && options.managedRuntimePolicyDigest !== MANAGED_RUNTIME_SOURCE_SHA256) throw new Error("MANAGED_RUNTIME_POLICY_VERSION_MISMATCH");
  return withOwnerFenceLock(configPath, () => withManagedRuntimePolicy(configPath, options.managedRuntimePolicy, async () => {
    if (options.runtimeInstallActionId) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.runtimeInstallActionId)) throw new Error("RUNTIME_INSTALL_ID_INVALID");
      const receipt = "/var/lib/golem-workers/runtime-install/actions/" + options.runtimeInstallActionId + ".json";
      try { if (await fs.stat(receipt.replace(/\.json$/, ".cancelled.json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }) || JSON.parse(await fs.readFile(receipt, "utf8")).postInstallCancelled) throw new Error("RUNTIME_INSTALL_SUPERSEDED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const previous = await readOwnerFence(configPath);
    if (incoming && previous && BigInt(incoming.revision) < BigInt(previous.revision)) throw new Error("STALE_OWNER_REVISION");
    if (incoming && previous && incoming.revision === previous.revision && JSON.stringify(incoming) !== JSON.stringify(previous)) throw new Error("OWNER_REVISION_CONFLICT");
    let current: string | undefined;
    try { current = await fs.readFile(configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (options.expectedRevision !== undefined && (current === undefined || configRevision(current) !== options.expectedRevision)) throw new Error("CONFIG_CONFLICT");
    if (options.expectedConfigText !== undefined && (options.expectedConfigText === null ? current !== undefined : (current === undefined || !isDeepStrictEqual(JSON5.parse(current), JSON5.parse(options.expectedConfigText))))) throw new Error("CONFIG_CONFLICT");
    const fence = incoming ?? previous;
    const { normalizeManagedConfigText } = await import("../managed-runtime/runtime-policy.js");
    const normalized = await normalizeManagedConfigText(configPath, text);
    const projected = fence ? projectOwners(normalized, fence) : normalized;
    const model = await readModelFence(configPath);
    if (model && !isAuthorizedModelSelection()) {
      const { managedRuntime } = await import("../managed-runtime/runtime-policy.js");
      if (current === undefined || (options.expectedRevision === undefined && options.expectedConfigText === undefined) || !isDeepStrictEqual(managedRuntime.protectedRoute(publicPortProjection(JSON5.parse(current), options.operationalPublicPort)), managedRuntime.protectedRoute(publicPortProjection(JSON5.parse(projected), options.operationalPublicPort)))) throw new Error("MODEL_FENCE_REQUIRED");
    }
    // Retain caller validation semantics. Owner projection itself validates the
    // narrow field; do not impose a new whole-config/media migration here.
    if (options.validate) {
      const candidate = configPath + ".candidate-" + randomUUID();
      try { await fs.writeFile(candidate, projected, { mode: 0o600, flag: "wx" }); await options.validate(candidate); }
      finally { await fs.rm(candidate, { force: true }); }
    }
    // Authority first: a crash after this point may require convergence, never
    // restore a lower authorization revision. Locks are never stolen on age.
    await commitManagedRuntimePolicy(configPath);
    if (incoming) await atomic(fenceBase(configPath) + ".owner-fence.json", JSON.stringify(incoming));
    await atomic(configPath, projected);
    return configRevision(projected);
  }));
}

// The established model/auth projection remains exact. This dedicated writer may
// change only these three operational values, with the usual owner lock and CAS.
function publicPortProjection(config: Record<string, unknown>, enabled?: boolean) {
  if (!enabled) return config;
  const projected = structuredClone(config) as { env?: Record<string, unknown> };
  const env = projected.env;
  if (env) {
    for (const key of ["GW_AGENT_PUBLIC_HOST", "GW_AGENT_PUBLIC_PORT", "GW_AGENT_PUBLIC_HTTP_URL"]) {
      delete env[key];
      if (env.vars && typeof env.vars === "object") delete (env.vars as Record<string, unknown>)[key];
    }
    if (env.vars && typeof env.vars === "object" && !Object.keys(env.vars).length) delete env.vars;
    if (!Object.keys(env).length) delete projected.env;
  }
  return projected;
}
export async function assertRuntimeActionNotCancelled(actionId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(actionId)) throw new Error("RUNTIME_INSTALL_ID_INVALID");
  try { await fs.stat("/var/lib/golem-workers/runtime-install/actions/" + actionId + ".cancelled.json"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("RUNTIME_INSTALL_SUPERSEDED");
}
