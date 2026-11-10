import fs from "node:fs/promises";
import { z } from "zod";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";

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
): Promise<void> {
  const deadline = Date.now() + 15_000;
  do {
    if ((await fs.readFile(configPath, "utf8")) !== expectedText)
      throw new Error("CONFIG_CONFLICT");
    const state = (await gateway.request(
      "config.get",
      {},
      { timeoutMs: 3000 },
    )) as {
      valid?: boolean;
      path?: string;
      config?: Record<string, unknown>;
      configRevisionHash?: string;
      appliedConfigHash?: string;
    };
    if (
      state.valid === true &&
      state.path === configPath &&
      state.config &&
      state.configRevisionHash &&
      state.configRevisionHash === state.appliedConfigHash
    ) {
      try {
        assertSubscriptionOnlyConfiguration(state.config, process.env, {
          runScopedFallbacks: false,
        });
        return;
      } catch {
        /* A cached pre-reload snapshot is not an applied cleanup. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    "OPENAI_POOL_CONFIG_RUNTIME_PENDING: fallback cleanup is saved; Gateway has not applied it. Pool remains pending.",
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
