import fs from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import { SubscriptionPoolError, assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";

/** Wait for the actual Gateway snapshot, not just a successful filesystem write. */
export async function waitForSubscriptionConfigApplied(
  configPath: string,
  expectedText: string,
  gateway: {
    request(
      method: string,
      params: Record<string, unknown>,
      options?: { timeoutMs: number },
    ): Promise<unknown>;
  },
  guard: { runScopedFallbacks: boolean } = { runScopedFallbacks: false },
  restartGateway?: () => Promise<void>,
  validateConfig?: (config: Record<string, unknown>) => void,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  if ((await fs.readFile(configPath, "utf8")) !== expectedText) throw new Error("CONFIG_CONFLICT");
  const expected: { gateway?: { reload?: { mode?: string } } } = JSON5.parse(expectedText);
  const reloadDisabled = expected.gateway?.reload?.mode === "off";
  let restarted = false;
  do {
    if ((await fs.readFile(configPath, "utf8")) !== expectedText)
      throw new Error("CONFIG_CONFLICT");
    let state: {
      valid?: boolean; path?: string; config?: Record<string, unknown>;
      configRevisionHash?: string; appliedConfigHash?: string;
    };
    try {
      state = (await gateway.request("config.get", {}, { timeoutMs: 3000 })) as typeof state;
    } catch (error) {
      // Only the restart we initiated grants a bounded reconnect wait.
      if (!restarted) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    if (!restarted && restartGateway && reloadDisabled && state.valid === true && state.path === configPath &&
        state.configRevisionHash && state.appliedConfigHash && state.configRevisionHash !== state.appliedConfigHash) {
      restarted = true;
      await restartGateway();
      continue;
    }
    if (
      state.valid === true &&
      state.path === configPath &&
      state.config &&
      state.configRevisionHash &&
      state.configRevisionHash === state.appliedConfigHash
    ) {
      try {
        if (validateConfig) validateConfig(state.config);
        else assertSubscriptionOnlyConfiguration(state.config, process.env, guard);
        return;
      } catch {
        /* A cached pre-reload snapshot is not an applied cleanup. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new SubscriptionPoolError(
    "OPENAI_POOL_CONFIG_RUNTIME_PENDING",
    "OPENAI_POOL_CONFIG_RUNTIME_PENDING: subscription configuration is saved; Gateway has not applied it. Pool remains pending.",
  );
}

/** Public post-mutation refresh invalidates shared-auth ownership as well as caches.
 * authStatus refresh is an inventory refresh and misses newly created ownership. */
export async function refreshSubscriptionPoolAuth(gateway: {
  request(
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs: number },
  ): Promise<unknown>;
}): Promise<void> {
  const roster = z
    .object({
      agents: z
        .array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }))
        .min(1),
    })
    .parse(await gateway.request("agents.list", {}, { timeoutMs: 3000 }));
  for (const agentId of new Set(roster.agents.map((agent) => agent.id))) {
    const result = await gateway.request(
      "models.authRefresh",
      { operation: "update", agentId },
      { timeoutMs: 10000 },
    );
    if (
      z.object({ refreshed: z.literal(true) }).safeParse(result).success !==
      true
    )
      throw new Error(
        "OPENAI_POOL_AUTH_RUNTIME_PENDING: Gateway did not acknowledge post-mutation auth refresh.",
      );
  }
}
