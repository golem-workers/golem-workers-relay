/** OpenClaw 2026.9.7 predates GPT-6.1-Sol in its native catalog. */
export function ensureNativePiModelCompatibility(config: Record<string, unknown>, subscriptionRoute = false): void {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const ensure = (parent: Record<string, unknown>, key: string): Record<string, unknown> =>
    record(parent[key]) ?? (parent[key] = {}) as Record<string, unknown>;
  const catalog = record(record(record(config.agents)?.defaults)?.models);
  if (!record(catalog?.["openai/gpt-6.1-sol"])) return;
  const provider = ensure(ensure(ensure(config, "models"), "providers"), "openai");
  provider.agentRuntime ??= { id: "openclaw" };
  const models: unknown[] = Array.isArray(provider.models) ? provider.models : [];
  provider.models = models;
  let model = models.map(record).find((entry) => entry?.id === "gpt-6.1-sol");
  if (!model) { model = { id: "gpt-6.1-sol" }; models.push(model); }
  // Never turn an authored endpoint/credential into a ChatGPT route. Leaving
  // api absent on those rows lets OpenClaw resolve the authored transport.
  const env = record(config.env);
  const hasAuthoredRoute = [provider, model].some((entry) =>
    ["api", "baseUrl", "apiKey", "auth", "headers"].some((key) => entry[key] !== undefined))
    || [env, record(env?.vars), process.env].some((entry) => entry?.OPENAI_BASE_URL !== undefined);
  const defaults: Record<string, unknown> = {
    name: "GPT-6.1-Sol",
    ...(!hasAuthoredRoute ? { api: subscriptionRoute ? "openai-chatgpt-responses" : "openai-responses" } : {}),
    reasoning: true, input: ["text", "image"], contextWindow: 272000,
    cost: { input: 2, output: 10 },
    agentRuntime: { id: "openclaw" },
  };
  for (const [key, value] of Object.entries(defaults)) if (model[key] === undefined) model[key] = value;
}
