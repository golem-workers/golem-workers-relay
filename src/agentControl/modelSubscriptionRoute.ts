import { getCodexLoginStatus, hasChatGptRouteOverrides, hasPersistedChatGptSubscription, hasPersistedOpenAiApiKey } from "./codexLogin.js";
import { readSubscriptionPoolState } from "./subscriptionPoolManager.js";
import { assertRuntimeSubscriptionGuard, type SubscriptionGuardGateway } from "./subscriptionGuard.js";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Pool Connect authors an explicit official endpoint. Legacy singleton status
 * calls that an override and reports its login inactive. For an applied pool,
 * require its live admission guard and strict route instead; never normalize,
 * install auth or declare inference successful here. The caller must still
 * prove the actual isolated reply's provider/model/harness. */
export async function hasVerifiedSubscriptionRoute(configPath: string, config: Record<string, unknown>, model: string, gateway: SubscriptionGuardGateway): Promise<boolean> {
  const environment = object(config.env);
  if ([environment, object(environment.vars), process.env].some(env => ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"].some(key => env[key] !== undefined))) return false;
  const pool = await readSubscriptionPoolState(configPath);
  if (pool && pool.phase !== "exited") {
    if (pool.phase !== "applied" || !pool.members.some(member => member.enabled)) return false;
    const guard = await assertRuntimeSubscriptionGuard(gateway);
    assertSubscriptionOnlyConfiguration(config, process.env, guard);
    return hasPersistedChatGptSubscription(configPath);
  }
  // Keep non-pool authorization policy unchanged, including API-key exclusion.
  const auth = await getCodexLoginStatus(configPath);
  const provider = object(object(object(config.models).providers).openai);
  const row = (Array.isArray(provider.models) ? provider.models : []).map(object).find(item => item.id === model.slice("codex/".length));
  const api = row?.api ?? provider.api;
  return (api === undefined || api === "openai-chatgpt-responses") && auth.state === "connected" && auth.authModes?.openaiLogin.active === true && await hasPersistedChatGptSubscription(configPath) && !await hasPersistedOpenAiApiKey(configPath) && !await hasChatGptRouteOverrides(configPath);
}
