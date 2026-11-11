import { describe, expect, it } from "vitest";
import { prepareSubscriptionPoolConfig } from "./subscriptionPoolConfig.js";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";
const env = { BACKEND_BASE_URL: "https://dev-api.golemworkers.com", RELAY_TOKEN: "synthetic-managed-token" };
const proxy = env.BACKEND_BASE_URL + "/api/v1/relays/openai/v1";
const generated = () => ({ baseUrl: proxy, models: [], agentRuntime: { id: "openclaw" } });
const fixture = () => ({
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna", fallbacks: [] },
    imageModel: { primary: "openai/gpt-5.4", fallbacks: ["openrouter/paid"] },
    thinkingDefault: "high", models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" }, params: { fastMode: false } } } } },
  models: { providers: { openai: generated(), codex: generated(), other: { baseUrl: "https://keep.test" } } },
  channels: { telegram: { enabled: true } }, tools: { deny: ["exec"] }, env: { KEEP: "untouched" },
});
describe("fresh-agent subscription Connect preparation", () => {
  it.each([false, true])("qualifies the generated route without changing model/Harness or mutating preflight input (runScoped=%s)", runScopedFallbacks => {
    const config = fixture(), before = structuredClone(config);
    const next = prepareSubscriptionPoolConfig(config, { runScopedFallbacks }, env);
    expect(config).toEqual(before);
    expect(next).toEqual({ ...before,
      agents: { defaults: { ...before.agents.defaults, imageModel: { ...before.agents.defaults.imageModel, fallbacks: runScopedFallbacks ? ["openrouter/paid"] : [] } } },
      models: { providers: { other: before.models.providers.other, openai: { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex", models: [], agentRuntime: { id: "openclaw" } } } },
    });
    expect(() => assertSubscriptionOnlyConfiguration(next, env, { runScopedFallbacks })).not.toThrow();
    expect(prepareSubscriptionPoolConfig(next, { runScopedFallbacks }, env)).toEqual(next);
  });
  it.each([
    { baseUrl: "https://custom.test/v1" }, { apiKey: "synthetic" }, { headers: { custom: "keep" } },
    { api: "openai-responses" }, { agentRuntime: { id: "codex" } }, { unknown: true },
  ])("does not repair an authored route %j", overrides => {
    const cfg = fixture(); Object.assign(cfg.models.providers.openai, overrides);
    const next = prepareSubscriptionPoolConfig(cfg, { runScopedFallbacks: false }, env);
    expect((next.models as typeof cfg.models).providers.openai).toEqual(cfg.models.providers.openai);
    expect(() => assertSubscriptionOnlyConfiguration(next, env, { runScopedFallbacks: false })).toThrow();
  });
  it.each([{ OPENAI_API_KEY: "synthetic" }, { CODEX_API_KEY: "synthetic" }, { OPENAI_BASE_URL: proxy }, { BACKEND_BASE_URL: "https://foreign.test" }])("preserves explicit environment/foreign route authority %j", extra => {
    const cfg = fixture(), authority = { ...env, ...extra };
    const next = prepareSubscriptionPoolConfig(cfg, { runScopedFallbacks: false }, authority);
    expect((next.models as typeof cfg.models).providers).toEqual(cfg.models.providers);
    expect(() => assertSubscriptionOnlyConfiguration(next, authority)).toThrow();
  });
  it("does not select an OpenAI model for a non-OpenAI agent", () => {
    const cfg = fixture(); cfg.agents.defaults.model.primary = "openrouter/openai/gpt-5.4-mini";
    const next = prepareSubscriptionPoolConfig(cfg, { runScopedFallbacks: false }, env);
    expect(() => assertSubscriptionOnlyConfiguration(next, env)).toThrow(/Select an explicit OpenAI/);
    expect(cfg.agents.defaults.model.primary).toBe("openrouter/openai/gpt-5.4-mini");
  });
});

it.each(["root", "vars"])("recognizes the exact generated credential+endpoint pair in config env (%s)", layout => {
 const cfg: Record<string, unknown> = fixture();
 cfg.env = layout === "root" ? { KEEP: "untouched", OPENAI_API_KEY: env.RELAY_TOKEN, OPENAI_BASE_URL: proxy } : { vars: { KEEP: "untouched", OPENAI_API_KEY: env.RELAY_TOKEN, OPENAI_BASE_URL: proxy } };
 const next=prepareSubscriptionPoolConfig(cfg,{runScopedFallbacks:false},env);
 expect(next.env).toEqual(layout === "root" ? {KEEP:"untouched"} : {vars:{KEEP:"untouched"}});
 expect(()=>assertSubscriptionOnlyConfiguration(next,env,{runScopedFallbacks:false})).not.toThrow();
});
it.each(["foreign-token", "foreign-endpoint", "missing-token-authority"])("preserves unproven config environment (%s)", mode => {
 const cfg=fixture() as Record<string, unknown>;
 cfg.env={OPENAI_API_KEY:mode==="foreign-token"?"user-key":env.RELAY_TOKEN,OPENAI_BASE_URL:mode==="foreign-endpoint"?"https://custom.test":proxy};
 const next=prepareSubscriptionPoolConfig(cfg,{runScopedFallbacks:false},mode==="missing-token-authority"?{BACKEND_BASE_URL:env.BACKEND_BASE_URL}:env);
 expect(next.env).toEqual(cfg.env);
 expect(()=>assertSubscriptionOnlyConfiguration(next,env)).toThrow();
});

it("keeps generated runtime metadata so Relay startup cannot re-dirty the prepared auth route", async () => {
 const {managedRuntime}=await import("../managed-runtime/runtime-policy.js");
 const next=prepareSubscriptionPoolConfig(fixture(),{runScopedFallbacks:false},env);
 const provider=structuredClone((next.models as {providers:Record<string,unknown>}).providers.openai);
 managedRuntime.normalizeConfig(next,{schemaVersion:1,revision:1,chatHarness:"openclaw"},{subscriptionAuth:true,env});
 expect((next.models as {providers:Record<string,unknown>}).providers.openai).toEqual(provider);
});
