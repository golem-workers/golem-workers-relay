import { describe, expect, it } from "vitest";
import { normalizeManagedSubscriptionRoute } from "./managedSubscriptionRoute.js";
const env = { BACKEND_BASE_URL: "https://dev-api.golemworkers.com" };
const baseUrl = env.BACKEND_BASE_URL + "/api/v1/relays/openai/v1";
const row = () => ({ baseUrl, models: [] });
const fixture = (openai: Record<string, unknown> = row()) => ({ models: { providers: { openai, codex: row(), anthropic: { baseUrl: "https://keep.test", models: [] } } } });
describe("managed subscription route normalization", () => {
  it("removes exact migrated and lingering aliases, preserving everything else, idempotently", () => {
    const cfg = { ...fixture(), auth: { order: { openai: ["openai:test"] } }, env: { vars: { OPENAI_TTS_BASE_URL: "https://keep.test" } } };
    const before = structuredClone(cfg);
    expect(normalizeManagedSubscriptionRoute(cfg, true, env)).toBe(true);
    expect(cfg).toEqual({ ...before, models: { providers: { anthropic: before.models.providers.anthropic } } });
    expect(normalizeManagedSubscriptionRoute(cfg, true, env)).toBe(false);
  });
  it("derives identity from a non-default deployment URL with a path and trailing slash", () => {
    const authority = { BACKEND_BASE_URL: " https://private.example.test/tenant/// " };
    const cfg = fixture({ baseUrl: "https://private.example.test/tenant/api/v1/relays/openai/v1", models: [] });
    expect(normalizeManagedSubscriptionRoute(cfg, true, authority)).toBe(true);
    expect(cfg.models.providers).not.toHaveProperty("openai");
    // A row from another deployment is not owned by this deployment.
    expect(cfg.models.providers.codex).toEqual(row());
  });
  it("preserves custom legacy codex rows rather than broad alias deletion", () => {
    const cfg = fixture();
    cfg.models.providers.codex = { baseUrl: "https://custom.example.test/v1", models: [] };
    const before = structuredClone(cfg.models.providers.codex);
    normalizeManagedSubscriptionRoute(cfg, true, env);
    expect(cfg.models.providers.codex).toEqual(before);
  });
  it.each([
    { api: "openai-responses" }, { auth: "api-key" }, { apiKey: "synthetic" },
    { headers: {} }, { request: { allowPrivateNetwork: true } }, { unknown: "keep" },
    { agentRuntime: { id: "openclaw" } }, { models: [{ id: "gpt-6.1-sol", api: "openai-responses" }] },
    { models: undefined }, { models: null },
    { baseUrl: "https://custom.test/api/v1/relays/openai/v1" },
    { baseUrl: baseUrl + "/" }, { baseUrl: baseUrl + "?custom=1" },
    { baseUrl: "https://dev-api.golemworkers.com.attacker.test/api/v1/relays/openai/v1" },
    { baseUrl: "http://127.0.0.1:18084/provider-proxy/openai/v1" },
  ])("preserves the entire ambiguous row %j", (overrides) => {
    const cfg = fixture({ ...row(), ...overrides });
    const before = structuredClone(cfg.models.providers.openai);
    normalizeManagedSubscriptionRoute(cfg, true, env);
    expect(cfg.models.providers.openai).toEqual(before);
    expect(cfg.models.providers).not.toHaveProperty("codex");
  });
  it.each([{}, { BACKEND_BASE_URL: "https://other.test" }, { BACKEND_BASE_URL: "bad" },
    { BACKEND_BASE_URL: "https://user:pass@dev-api.golemworkers.com" },
    { BACKEND_BASE_URL: "https://dev-api.golemworkers.com?query=1" },
    { ...env, OPENAI_API_KEY: "synthetic" }, { ...env, CODEX_API_KEY: "synthetic" },
    { ...env, OPENAI_BASE_URL: baseUrl },
  ])("fails closed without unambiguous deployment authority %j", (authority) => {
    const cfg = fixture(); const before = structuredClone(cfg);
    expect(normalizeManagedSubscriptionRoute(cfg, true, authority)).toBe(false);
    expect(cfg).toEqual(before);
  });
  it.each([
    { env: { OPENAI_API_KEY: "synthetic" } }, { env: { vars: { OPENAI_API_KEY: "synthetic" } } },
    { env: { vars: { OPENAI_BASE_URL: baseUrl } } },
    { auth: { profiles: { "openai:key": { provider: "openai", mode: "api_key" } } } },
  ])("preserves explicit API intent %j", (extra) => {
    const cfg = { ...fixture(), ...extra }; const before = structuredClone(cfg);
    expect(normalizeManagedSubscriptionRoute(cfg, true, env)).toBe(false);
    expect(cfg).toEqual(before);
  });
  it("requires saved subscription, not a model alias", () => {
    const cfg = fixture(); const before = structuredClone(cfg);
    expect(normalizeManagedSubscriptionRoute(cfg, false, env)).toBe(false);
    expect(cfg).toEqual(before);
  });
});
