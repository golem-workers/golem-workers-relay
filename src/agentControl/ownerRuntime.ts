import { isDeepStrictEqual } from "node:util";
import { readOwnerFence, withOwnerFenceLock, projectOwners } from "./ownerFence.js";
import type { AgentControlResult } from "./protocol.js";
type Receipt = NonNullable<Extract<AgentControlResult, { kind: "config.read" }>["ownerRuntime"]>;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
async function boundedRequest(gateway: { request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> }, method: string, params: unknown) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([gateway.request(method, params, { timeoutMs: 15_000 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("OWNER_RUNTIME_TIMEOUT")), 15_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
// Gateway projected resolved hashes share a namespace only with each other.
// Hold the commit gate to bind enrollment to this observation, never restart.
export async function readOwnerRuntime(configPath: string, gateway: {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}, snapshotOnly = false): Promise<Receipt> {
  const observe = async (): Promise<Receipt> => {
    const enrolledFence = await readOwnerFence(configPath);
    const base: Receipt = { version: 1, state: "pending", enrolledFence, configRevisionHash: null, appliedConfigHash: null, config: null };
    if (!enrolledFence) return base;
    try {
      const response = await boundedRequest(gateway, "config.get", {});
      if (!record(response) || !("configRevisionHash" in response) || !("appliedConfigHash" in response)) return { ...base, state: "unsupported" };
      if (response.valid !== true || !record(response.config)) return base;
      const revision = typeof response.configRevisionHash === "string" && response.configRevisionHash.length ? response.configRevisionHash : null;
      const applied = typeof response.appliedConfigHash === "string" && response.appliedConfigHash.length ? response.appliedConfigHash : null;
      const receipt = { ...base, configRevisionHash: revision, appliedConfigHash: applied, config: response.config };
      if (!revision || revision !== applied) return receipt;
      if (response.path !== configPath) return receipt;
      if (!isDeepStrictEqual(JSON.parse(projectOwners(JSON.stringify(response.config), enrolledFence)), response.config)) return receipt;
      const channels = await boundedRequest(gateway, "channels.status", { probe: false });
      // Applied hash is published after reload work; reject explicit channel
      // deferral/policy diagnostics too rather than inferring channel health.
      if (!record(channels) || !Array.isArray(channels.statusIssues)) return { ...receipt, state: "unsupported" };
      if (channels.statusIssues.length) return receipt;
      // A core/CLI writer is not covered by the companion filesystem lock.
      // Re-read across the channel observation to reject a superseded receipt.
      const after = await boundedRequest(gateway, "config.get", {});
      if (!record(after) || after.valid !== true || after.path !== configPath || after.configRevisionHash !== revision || after.appliedConfigHash !== applied || !isDeepStrictEqual(after.config, response.config)) return receipt;
      if (!isDeepStrictEqual(await readOwnerFence(configPath), enrolledFence)) return { ...receipt, state: "pending" };
      return { ...receipt, state: "applied" };
    } catch { return { ...base, state: "unavailable" }; }
  };
  return snapshotOnly ? observe() : withOwnerFenceLock(configPath, observe);
}
