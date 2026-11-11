import { isGeneratedSolCatalog, managedOpenAiRelayBaseUrl, normalizeManagedSubscriptionRoute } from "./managedSubscriptionRoute.js";
import { clearSubscriptionModelFallbacks } from "./subscriptionModelFallbacks.js";

/** Explicit Connect prepares auth routing, not model intent. Only exact platform-
 * generated proxy rows may become ChatGPT routes; authored routes stay intact
 * and must pass the ordinary subscription-only validator. Also used read-only
 * by preflight and as the exact allowlist for the CAS/model-fenced writer. */
export function prepareSubscriptionPoolConfig(
  config: Record<string, unknown>,
  guard: { runScopedFallbacks: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const next = guard.runScopedFallbacks
    ? structuredClone(config)
    : clearSubscriptionModelFallbacks(config);
  // Fresh provisioning also injects the exact per-agent Relay token/endpoint
  // pair into Gateway env. These are platform proxy credentials, not a user's
  // OpenAI API key. Never clear either half without exact deployment identity.
  const endpoint = managedOpenAiRelayBaseUrl(env);
  const token = env.RELAY_TOKEN?.trim();
  const envRoot = next.env as Record<string, unknown> | undefined;
  let generatedEnvironment = false;
  for (const row of [envRoot, envRoot?.vars as Record<string, unknown> | undefined]) {
    if (row && endpoint && token && row.OPENAI_BASE_URL === endpoint && row.OPENAI_API_KEY === token) {
      generatedEnvironment = true;
      delete row.OPENAI_API_KEY;
      delete row.OPENAI_BASE_URL;
    }
  }
  const priorProvider = (next.models as { providers?: { openai?: Record<string, unknown> } } | undefined)?.providers?.openai;
  // A prior explicit exit writes this exact platform API route. Its per-agent
  // environment pair proves custody; authored API routes remain untouched.
  if (generatedEnvironment && priorProvider?.api === "openai-responses" && priorProvider.baseUrl === endpoint) {
    const withoutApi = { ...priorProvider }; delete withoutApi.api;
    if (isGeneratedSolCatalog(withoutApi, false)) {
      delete priorProvider.api;
      for (const row of priorProvider.models as Record<string, unknown>[]) row.api = "openai-chatgpt-responses";
    } else if (Array.isArray(priorProvider.models) && !priorProvider.models.length &&
      Object.keys(priorProvider).every(k => ["api", "baseUrl", "models", "agentRuntime", "pickerRuntimes"].includes(k))) delete priorProvider.api;
  }
  if (normalizeManagedSubscriptionRoute(next, true, env)) {
    const providers = (next.models as { providers: Record<string, unknown> }).providers;
    // The normalizer deletes only the exact generated empty provider. Preserve
    // any surviving authored/provider-model catalog in its entirety.
    if (!providers.openai) providers.openai = {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [],
      ...(priorProvider?.agentRuntime !== undefined ? { agentRuntime: priorProvider.agentRuntime } : {}),
      ...(priorProvider?.pickerRuntimes !== undefined ? { pickerRuntimes: priorProvider.pickerRuntimes } : {}),
    };
  }
  return next;
}
