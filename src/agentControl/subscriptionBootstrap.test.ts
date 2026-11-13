import { expect, it } from "vitest";
import { prepareSubscriptionBootstrap } from "./subscriptionBootstrap.js";
import { prepareSubscriptionPoolConfig } from "./subscriptionPoolConfig.js";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";
import { ensureNativePiModelCompatibility } from "./nativePiModelCompatibility.js";
const env = { BACKEND_BASE_URL: "https://api.example.test", RELAY_TOKEN: "synthetic" };
const endpoint = env.BACKEND_BASE_URL + "/api/v1/relays/openai/v1";
function fixture() {
 const config: Record<string, unknown> = { agents: { defaults: { model: { primary: "openai/gpt-6.1-sol", fallbacks: [] }, models: { "openai/gpt-6.1-sol": {} }, imageModel: { primary: "openai/gpt-5.4", fallbacks: ["openrouter/other"] }, mediaModels: { video: { primary: "fal/video", fallbacks: ["openai/sora"] } }, pdfModel: { primary: "openai/gpt-5.4-mini", fallbacks: ["openai/gpt-5.4"] } } }, models: { providers: { openai: { baseUrl: endpoint, models: [] }, codex: { baseUrl: endpoint, models: [] } } }, env: { OPENAI_BASE_URL: endpoint, OPENAI_API_KEY: env.RELAY_TOKEN }, channels: { telegram: { enabled: true } }, tools: { deny: ["dangerous"] } };
 ensureNativePiModelCompatibility(config, false, {}); return config;
}
it("reproduces fresh Sol AUTH refusal, then prepares the explicit initial subscription model without touching credentials", () => {
 const config = fixture(), before = structuredClone(config);
 expect(() => assertSubscriptionOnlyConfiguration(prepareSubscriptionPoolConfig(config, { runScopedFallbacks: false }, env), env, { runScopedFallbacks: false })).toThrow();
 const next = prepareSubscriptionBootstrap(config, env);
 expect(config).toEqual(before);
 expect(() => assertSubscriptionOnlyConfiguration(next, env, { runScopedFallbacks: false })).not.toThrow();
 expect(next.channels).toEqual(before.channels); expect(next.tools).toEqual(before.tools);
 expect(JSON.stringify(next)).not.toContain("openrouter/other");
 expect(prepareSubscriptionBootstrap(next, env)).toEqual(next);
});
it.each(["endpoint", "headers", "model", "token"])("does not overwrite authored %s authority", kind => {
 const config = fixture();
 const provider = (config.models as {providers: {openai: Record<string, unknown>}}).providers.openai;
 if (kind === "endpoint") provider.baseUrl = "https://custom.test";
 if (kind === "headers") provider.headers = { custom: "keep" };
 if (kind === "model") (provider.models as Record<string,unknown>[])[0].contextWindow = 9999;
 if (kind === "token") (config.env as Record<string,unknown>).OPENAI_API_KEY = "authored";
 const before = structuredClone(config);
 expect(() => prepareSubscriptionBootstrap(config, env)).toThrow(); expect(config).toEqual(before);
});

it("qualifies a non-Sol template while retaining the platform Sol catalog", () => {
 const config = fixture();
 (config.agents as {defaults:{model:{primary:string}}}).defaults.model.primary = "openai/gpt-5.6-luna";
 const next = prepareSubscriptionBootstrap(config,env);
 expect(() => assertSubscriptionOnlyConfiguration(next,env,{runScopedFallbacks:false})).not.toThrow();
 expect((next.models as {providers:{openai:{api:string}}}).providers.openai.api).toBe("openai-chatgpt-responses");
});
