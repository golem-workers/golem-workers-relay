import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import JSON5 from "json5";
import { createManagedRuntimePolicy, type ManagedRuntimePolicy, type RuntimeContext } from "./policy.generated.js";
export const managedRuntime = createManagedRuntimePolicy();
const scope = new AsyncLocalStorage<{ configPath: string; policy: ManagedRuntimePolicy; allowMissingAuth?: boolean }>();
export function policyFile(configPath: string): string {
  return configPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/managed-runtime-policy.json" : configPath + ".managed-runtime-policy.json";
}
export async function readManagedRuntimePolicy(configPath: string): Promise<ManagedRuntimePolicy> {
  const active = scope.getStore();
  if (active?.configPath === path.resolve(configPath)) return active.policy;
  try {
    // This sidecar is committed only by the authenticated backend/privileged writer.
    // Startup must not require a new environment key on existing agent servers.
    return managedRuntime.parsePolicy(JSON.parse(await fs.readFile(policyFile(configPath), "utf8")));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...managedRuntime.defaultPolicy }; throw error; }
}
async function persistPolicy(configPath: string, incoming: ManagedRuntimePolicy): Promise<void> {
  const target = policyFile(configPath);
  let current: ManagedRuntimePolicy = managedRuntime.defaultPolicy;
  try { current = managedRuntime.parsePolicy(JSON.parse(await fs.readFile(target, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Retain the persisted server binding and both revision fences on every write.
  managedRuntime.acceptPolicy(current, incoming);
  if (JSON.stringify(current) === JSON.stringify(incoming)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + "." + randomUUID();
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(incoming) + "\n"); await file.sync(); } finally { await file.close(); }
    await fs.rename(temporary, target);
    const directory = await fs.open(path.dirname(target), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
/** Called inside model/owner mutation locks. Incoming authority is carried by the
 * authenticated backend action, never by arbitrary OpenClaw config text. */
export async function withManagedRuntimePolicy<T>(configPath: string, incoming: ManagedRuntimePolicy | undefined, operation: () => Promise<T>, options?: { allowMissingAuth?: boolean }): Promise<T> {
  const inherited = scope.getStore();
  return scope.run({ configPath: "", policy: managedRuntime.defaultPolicy }, async () => {
    const current = inherited?.configPath === path.resolve(configPath) ? inherited.policy : await readManagedRuntimePolicy(configPath);
    // First scoped authority comes from authenticated backend ingress. Subsequent
    // authority must retain that server binding and monotonic revision counters.
    const policy = incoming ? managedRuntime.acceptPolicy(current, incoming) : current;
    return scope.run({ configPath: path.resolve(configPath), policy, allowMissingAuth: (options?.allowMissingAuth === true || (options === undefined && inherited?.configPath === path.resolve(configPath) && inherited.allowMissingAuth === true)) && current.chatHarness === "codex" && JSON.stringify(current) === JSON.stringify(policy) }, operation);
  });
}
export async function runtimeContext(configPath: string): Promise<RuntimeContext> {
  const { hasPersistedChatGptSubscription, hasPersistedOpenAiApiKey } = await import("../agentControl/codexLogin.js");
  return { allowMissingAuth: scope.getStore()?.configPath === path.resolve(configPath) && scope.getStore()?.allowMissingAuth === true, env: process.env, subscriptionAuth: await hasPersistedChatGptSubscription(configPath), apiKeyAuth: await hasPersistedOpenAiApiKey(configPath) };
}
/** The single local write boundary. CAS is checked by the caller BEFORE this runs;
 * credentials/model refs/routes are not rewritten. Incompatible Codex choice fails
 * before either policy authority or configuration is committed. */
export async function normalizeManagedConfigText(configPath: string, text: string): Promise<string> {
  const config: Record<string, unknown> = JSON5.parse(text);
  const policy = await readManagedRuntimePolicy(configPath);
  managedRuntime.normalizeConfig(config, policy, await runtimeContext(configPath));
  return JSON.stringify(config, null, 2) + "\n";
}
export async function normalizeManagedConfigOnDisk(configPath: string): Promise<boolean> {
  const { withOwnerFenceLock, writeOwnerFencedConfig } = await import("../agentControl/ownerFence.js");
  return withOwnerFenceLock(configPath, async () => {
    const current = await fs.readFile(configPath, "utf8");
    const normalized = await normalizeManagedConfigText(configPath, current);
    if (JSON.stringify(JSON5.parse(current)) === JSON.stringify(JSON5.parse(normalized))) { await commitManagedRuntimePolicy(configPath); return false; }
    await writeOwnerFencedConfig(configPath, normalized, undefined, { expectedConfigText: current });
    return true;
  });
}
export function activeManagedConfigPath(): string | undefined { return scope.getStore()?.configPath; }

/** Must run inside the owner write lock, after CAS and schema validation. */
export async function commitManagedRuntimePolicy(configPath: string): Promise<void> { await persistPolicy(configPath, await readManagedRuntimePolicy(configPath)); }

/** Recheck persisted authority on lock acquisition, before auth/CLI side effects. */
export async function recheckManagedRuntimePolicy(configPath: string): Promise<void> {
  const active = scope.getStore();
  if (active?.configPath !== path.resolve(configPath)) return;
  let current: ManagedRuntimePolicy = managedRuntime.defaultPolicy;
  try { current = managedRuntime.parsePolicy(JSON.parse(await fs.readFile(policyFile(configPath), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  managedRuntime.acceptPolicy(current, active.policy);
}
