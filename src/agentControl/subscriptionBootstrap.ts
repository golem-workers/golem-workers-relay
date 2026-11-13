import { isDeepStrictEqual } from "node:util";
import { ensureNativePiModelCompatibility } from "./nativePiModelCompatibility.js";
import { isGeneratedSolCatalog, managedOpenAiRelayBaseUrl } from "./managedSubscriptionRoute.js";
import { prepareSubscriptionPoolConfig } from "./subscriptionPoolConfig.js";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";
import { clearSubscriptionModelFallbacks } from "./subscriptionModelFallbacks.js";

/** Explicit initial model selection, never called by auth-only Connect. Only
 * exact platform-generated catalogs may change transport; custom rows fail closed. */
export function prepareSubscriptionBootstrap(config: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const next = clearSubscriptionModelFallbacks(config);
  const provider = (next.models as { providers?: { openai?: Record<string, unknown> } } | undefined)?.providers?.openai;
  const generated: Record<string, unknown> = { agents: { defaults: { models: { "openai/gpt-6.1-sol": {} } } }, models: { providers: { openai: { baseUrl: managedOpenAiRelayBaseUrl(env), models: [] } } } };
  ensureNativePiModelCompatibility(generated, false, {});
  const generatedProvider = (generated.models as { providers: { openai: unknown } }).providers.openai;
  if (provider && provider.baseUrl === managedOpenAiRelayBaseUrl(env) && (isGeneratedSolCatalog(provider, false) || isDeepStrictEqual(provider, generatedProvider))) {
    provider.api = "openai-chatgpt-responses";
    provider.baseUrl = "https://chatgpt.com/backend-api/codex";
    for (const model of provider.models as Array<Record<string, unknown>>) model.api = "openai-chatgpt-responses";
  }
  const prepared = prepareSubscriptionPoolConfig(next, { runScopedFallbacks: false }, env);
  assertSubscriptionOnlyConfiguration(prepared, env, { runScopedFallbacks: false });
  return prepared;
}
