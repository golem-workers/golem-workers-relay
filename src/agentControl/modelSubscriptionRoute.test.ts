import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ pool: vi.fn<() => Promise<{ phase: string; members: { enabled: boolean }[] } | null>>(), auth: vi.fn(), subscription: vi.fn<() => Promise<boolean>>(), apiKey: vi.fn<() => Promise<boolean>>(), overrides: vi.fn<() => Promise<boolean>>() }));
vi.mock("./subscriptionPoolManager.js", () => ({ readSubscriptionPoolState: m.pool }));
vi.mock("./codexLogin.js", () => ({ getCodexLoginStatus: m.auth, hasPersistedChatGptSubscription: m.subscription, hasPersistedOpenAiApiKey: m.apiKey, hasChatGptRouteOverrides: m.overrides }));
import { hasVerifiedSubscriptionRoute } from "./modelSubscriptionRoute.js";
const config = () => ({ agents: { defaults: { model: { primary: "openai/gpt-5.6-sol", fallbacks: [] as string[] } } }, models: { providers: { openai: { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex", models: [] } } } });
const gateway = () => ({ request: vi.fn(() => Promise.resolve({ version: 2, runScopedFallbacks: false, configuredFallbacksForbidden: true, readOnlyAdmission: true })) });
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) vi.stubEnv(key, undefined);
  m.pool.mockResolvedValue({ phase: "applied", members: [{ enabled: true }] });
  m.auth.mockResolvedValue({ state: "connected", authModes: { openaiLogin: { active: false } } });
  m.subscription.mockResolvedValue(true); m.apiKey.mockResolvedValue(false); m.overrides.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
it("accepts the official applied pool despite legacy inactive/override classification, with live guard and real subscription", async () => {
  const g = gateway(), c = config(), before = JSON.stringify(c);
  await expect(hasVerifiedSubscriptionRoute("config", c, "codex/gpt-5.6-sol", g)).resolves.toBe(true);
  expect(g.request).toHaveBeenCalledWith("relay-channel.subscriptionGuard.status", {}, { timeoutMs: 3000 });
  expect(m.subscription).toHaveBeenCalledWith("config"); expect(m.auth).not.toHaveBeenCalled(); expect(JSON.stringify(c)).toBe(before);
});
it.each(["pending", "exiting"])("does not treat %s pool custody as applied auth", async phase => {
  m.pool.mockResolvedValue({ phase, members: [{ enabled: true }] }); const g = gateway();
  await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", g)).resolves.toBe(false); expect(g.request).not.toHaveBeenCalled();
});
it.each([{ members: [] }, { members: [{ enabled: false }] }])("rejects an empty or disabled pool %j", async ({ members }) => {
  m.pool.mockResolvedValue({ phase: "applied", members }); await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
});
it("does not substitute a manifest for persisted subscription credentials", async () => {
  m.subscription.mockResolvedValue(false); await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
});
it("requires the loaded guard, not a pool/version string", async () => {
  await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", { request: () => Promise.resolve({ version: 2 }) })).rejects.toMatchObject({ code: "OPENAI_POOL_GUARD_UPDATE_REQUIRED" });
});
it.each(["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"])("rejects process routing override %s", async key => {
  vi.stubEnv(key, "fixture"); await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
});
it("rejects config environment routing overrides", async () => {
  await expect(hasVerifiedSubscriptionRoute("config", { ...config(), env: { vars: { OPENAI_API_KEY: "fixture" } } }, "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
});
it.each(["https://api.openai.com/v1", "https://custom.example/v1"])("rejects non-subscription endpoint %s even with an applied pool", async baseUrl => {
  const c = config(); c.models.providers.openai.baseUrl = baseUrl; await expect(hasVerifiedSubscriptionRoute("config", c, "codex/gpt-5.6-sol", gateway())).rejects.toMatchObject({ code: "OPENAI_POOL_ROUTE_UNSUPPORTED" });
});
it("rejects direct provider API-key auth and configured fallback", async () => {
  const c = config(); await expect(hasVerifiedSubscriptionRoute("config", { ...c, models: { providers: { openai: { ...c.models.providers.openai, apiKey: "fixture" } } } }, "codex/gpt-5.6-sol", gateway())).rejects.toMatchObject({ code: "OPENAI_POOL_ROUTE_UNSUPPORTED" });
  c.agents.defaults.model.fallbacks = ["openrouter/other"]; await expect(hasVerifiedSubscriptionRoute("config", c, "codex/gpt-5.6-sol", gateway())).rejects.toMatchObject({ code: "OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN" });
});
it.each([null, { phase: "exited", members: [{ enabled: true }] }])("preserves non-pool singleton restrictions after %j", async pool => {
  m.pool.mockResolvedValue(pool); await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
  m.auth.mockResolvedValue({ state: "connected", authModes: { openaiLogin: { active: true } } }); m.overrides.mockResolvedValue(false);
  await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(true);
  m.apiKey.mockResolvedValue(true); await expect(hasVerifiedSubscriptionRoute("config", config(), "codex/gpt-5.6-sol", gateway())).resolves.toBe(false);
});
