import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { createManagedRuntimePolicy, MANAGED_RUNTIME_FACTORY_SOURCE } from "./policy.generated.js";
const engine = createManagedRuntimePolicy();
const codex = { schemaVersion: 1 as const, revision: 2, chatHarness: "codex" as const };
const native = engine.defaultPolicy;
const ref = "openai/gpt-6.1-sol";
const fixture = () => ({
  agents: { defaults: { model: { primary: ref, fallbacks: [] as string[] }, models: { [ref]: {} as Record<string, unknown> } } },
  models: { providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-secret-ref", models: [{ id: "gpt-6.1-sol" }] } } },
});
describe("canonical managed runtime contract", () => {
  it.each([native, codex])("has identical self-contained generated behavior and idempotence for $chatHarness", policy => {
    const direct = fixture(), remote = fixture();
    engine.normalizeConfig(direct, policy);
    runInNewContext(MANAGED_RUNTIME_FACTORY_SOURCE + "createManagedRuntimePolicy().normalizeConfig(config, policy);", { config: remote, policy, URL });
    expect(remote).toEqual(direct);
    expect(direct.agents.defaults.models[ref]).toMatchObject({ agentRuntime: { id: policy.chatHarness } });
    const first = structuredClone(direct); engine.normalizeConfig(direct, policy); expect(direct).toEqual(first);
    expect(direct.models.providers.openai).toMatchObject({ baseUrl: "https://api.openai.com/v1", apiKey: "fixture-secret-ref", api: "openai-responses" });
  });
  it.each(["headers", "request", "params", "localService", "authHeader", "timeoutSeconds", "requestTransportOverrides", "requestOptions", "compat"])("rejects unreproducible %s provider/model/catalog overrides without partial writes", key => {
    for (const level of ["provider", "model", "catalog"]) {
      const config = fixture();
      const target = level === "provider" ? config.models.providers.openai : level === "model" ? config.models.providers.openai.models[0] : config.agents.defaults.models[ref];
      Object.assign(target, { [key]: key === "timeoutSeconds" ? 30 : key === "params" ? { temperature: 0.6 } : { custom: true } });
      const before = structuredClone(config);
      expect(() => engine.normalizeConfig(config, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE");
      expect(config).toEqual(before);
    }
  });
  it.each(["http://api.openai.com/v1", "https://api.openai.com.attacker.test/v1", "https://api.openai.com/v1?x=1", "https://proxy.test/v1"])("preserves but refuses incompatible route %s", endpoint => {
    const config = fixture(); config.models.providers.openai.baseUrl = endpoint;
    const before = structuredClone(config); expect(() => engine.normalizeConfig(config, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE"); expect(config).toEqual(before);
    engine.normalizeConfig(config, native); expect(config.models.providers.openai.baseUrl).toBe(endpoint);
  });
  it("accepts reproducible fast controls but rejects global/per-agent arbitrary params, including inherited model", () => {
    const config = fixture(); config.agents.defaults.models[ref].params = { fastMode: "auto", fastAutoOnSeconds: 30 };
    engine.normalizeConfig(config, codex);
    for (const scope of ["default", "agent"]) {
      const params = { temperature: 0.4 };
      const candidate = { ...fixture(), agents: scope === "default" ? { defaults: { ...fixture().agents.defaults, params } } : { defaults: fixture().agents.defaults, list: [{ id: "other", params }] } };
      expect(() => engine.normalizeConfig(candidate, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE");
    }
  });
  it("rejects unsupported main and fallback providers; explicit auxiliary native scope is not a chat fallback", () => {
    const config = fixture(); config.agents.defaults.model.fallbacks = ["anthropic/claude"];
    expect(() => engine.normalizeConfig(config, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE");
    config.agents.defaults.model.fallbacks = [];
    const mixed = { ...config, agents: { defaults: { ...config.agents.defaults, imageGenerationModel: { primary: "openai/gpt-image-2" }, pdfModel: { primary: "anthropic/claude" } } } };
    engine.normalizeConfig(mixed, codex);
    expect(mixed.agents.defaults.models).toMatchObject({ "openai/gpt-image-2": { agentRuntime: { id: "openclaw" } }, "anthropic/claude": { agentRuntime: { id: "openclaw" } }, [ref]: { agentRuntime: { id: "codex" } } });
    mixed.agents.defaults.imageGenerationModel.primary = ref;
    expect(() => engine.normalizeConfig(mixed, codex)).toThrow("MANAGED_RUNTIME_PURPOSE_CONFLICT");
  });
  it("normalizes defaults, list and entries model metadata without inventing whole-agent runtime keys", () => {
    const config = { ...fixture(), agents: { defaults: fixture().agents.defaults, list: [{ id: "legacy", model: ref, models: { [ref]: { agentRuntime: { id: "copilot" }, pickerRuntimes: ["copilot"] } } }], entries: { named: { model: { primary: ref, fallbacks: [] }, models: { [ref]: { agentRuntime: { id: "auto" } } } } } } };
    engine.normalizeConfig(config, codex);
    expect(config.agents.list[0]).toMatchObject({ models: { [ref]: { agentRuntime: { id: "codex" }, pickerRuntimes: ["codex"] } } });
    expect(config.agents.entries.named.models[ref].agentRuntime.id).toBe("codex");
    expect(config.agents.list[0]).not.toHaveProperty("agentRuntime");
  });
  it("never infers OAuth from runtime; Sol retains authored API routing and explicit key intent", () => {
    for (const context of [{ apiKeyAuth: true, subscriptionAuth: true }, { env: { OPENAI_API_KEY: "fixture" }, subscriptionAuth: true }]) {
      const config = { agents: { defaults: { model: { primary: ref }, models: { [ref]: { agentRuntime: { id: "codex" } } } } } };
      engine.normalizeConfig(config, native, context);
      expect(config).toMatchObject({ models: { providers: { openai: { models: [{ api: "openai-responses" }] } } } });
    }
    const authored = fixture(); delete (authored.models.providers.openai as { api?: string }).api;
    engine.normalizeConfig(authored, native, { subscriptionAuth: true });
    expect(authored.models.providers.openai.models[0]).not.toHaveProperty("api");
    expect(engine.isSubscriptionRoute(fixture(), ref, { subscriptionAuth: true })).toBe(false);
  });
  it("fence projection ignores only recognized runtime metadata, retaining routes, auth and nested transport fields", () => {
    const config = fixture(), corrected = structuredClone(config); engine.normalizeConfig(corrected, codex);
    // Projection compares existing route fields, so a catalog addition is not free.
    engine.normalizeConfig(config, native);
    expect(engine.protectedRoute(config)).toEqual(engine.protectedRoute(corrected));
    expect(() => engine.assertRuntimeMetadata(corrected, native)).toThrow("MANAGED_RUNTIME_METADATA_CONFLICT");
    const hostile = structuredClone(config); hostile.models.providers.openai.baseUrl = "https://evil.test/v1";
    expect(engine.protectedRoute(hostile)).not.toEqual(engine.protectedRoute(config));
    Object.assign(hostile.models.providers.openai, { headers: { agentRuntime: "must-remain-protected" } });
    expect(engine.protectedRoute(hostile)).not.toEqual(engine.protectedRoute(config));
  });
  it("requires explicit revision >=2 for first Codex authority; stale or conflicting choices fail closed", () => {
    expect(() => engine.acceptPolicy(native, { ...codex, revision: 1 })).toThrow("CONFLICT");
    expect(engine.acceptPolicy(native, codex)).toEqual(codex);
    expect(() => engine.acceptPolicy(codex, native)).toThrow("STALE");
    expect(() => engine.parsePolicy({ ...codex, arbitrary: true })).toThrow("INVALID");
  });
});

it("protects legacy provider routing and rejects per-agent request overlays", () => {
  const cfg = fixture(); engine.normalizeConfig(cfg, native);
  expect(engine.protectedRoute({ ...cfg, providers: { openai: { baseUrl: "https://one.test" } } })).not.toEqual(engine.protectedRoute({ ...cfg, providers: { openai: { baseUrl: "https://two.test" } } }));
  const overlaid = { ...fixture(), agents: { defaults: fixture().agents.defaults, entries: { other: { request: { custom: true } } } } };
  expect(() => engine.normalizeConfig(overlaid, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE");
  const empty = fixture(); Object.assign(empty.models.providers.openai, { headers: {}, request: {}, compat: {} }); engine.normalizeConfig(empty, codex);
});

it("preserves provisioned agent turn budgets without confusing them with provider request timeouts", () => {
  const cfg = { ...fixture(), agents: { defaults: { ...fixture().agents.defaults, timeoutSeconds: 259200 }, list: [{ id: "worker", timeoutSeconds: 3600 }], entries: { other: { timeoutSeconds: 7200 } } } };
  expect(engine.codexCompatibility(cfg, ref)).toEqual({ supported: true });
  const generated = structuredClone(cfg);
  engine.normalizeConfig(cfg, codex);
  runInNewContext(MANAGED_RUNTIME_FACTORY_SOURCE + "createManagedRuntimePolicy().normalizeConfig(config, policy);", { config: generated, policy: codex, URL });
  expect(generated).toEqual(cfg);
  expect(cfg.agents.defaults.timeoutSeconds).toBe(259200); expect(cfg.agents.list[0].timeoutSeconds).toBe(3600); expect(cfg.agents.entries.other.timeoutSeconds).toBe(7200);
  expect(cfg.agents.defaults.models[ref]).toMatchObject({ agentRuntime: { id: "codex" } });
  for (const level of ["provider", "model", "catalog"]) {
    const request = fixture(); const target = level === "provider" ? request.models.providers.openai : level === "model" ? request.models.providers.openai.models[0] : request.agents.defaults.models[ref];
    Object.assign(target, { timeoutSeconds: 30 });
    expect(engine.codexCompatibility(request, ref).supported).toBe(false);
    expect(() => engine.normalizeConfig(request, codex)).toThrow("MANAGED_CODEX_INCOMPATIBLE");
  }
});

describe("agent scoped policy V2", () => {
  const scoped = (serverId = "server-a", harnessOverride: "codex" | "openclaw" | null = null, revision = 0, global = native) => engine.resolveAgentPolicy(global, { serverId, harnessOverride, revision });
  it("isolates servers, preserves pinned choices on global bumps, and permits same-global agent switches", () => {
    const a = scoped("server-a", "openclaw", 3);
    const b = scoped("server-b", "codex", 1);
    const bumped = scoped("server-a", "openclaw", 3, codex);
    expect(engine.acceptPolicy(a, bumped)).toEqual(bumped);
    expect(bumped.chatHarness).toBe("openclaw");
    expect(b.chatHarness).toBe("codex");
    expect(engine.acceptPolicy(bumped, scoped("server-a", null, 4, codex)).chatHarness).toBe("codex");
    expect(engine.acceptPolicy(scoped(), scoped("server-a", null, 0, codex)).chatHarness).toBe("codex");
    expect(() => engine.acceptPolicy(a, b)).toThrow("SERVER_MISMATCH");
    expect(() => engine.assertPolicyServer(a, undefined)).toThrow("SERVER_MISMATCH");
  });
  it("rejects either revision regressing and equal-domain conflicts", () => {
    const current = scoped("server-a", "codex", 3, codex);
    for (const next of [scoped("server-a", "codex", 2, codex), scoped("server-a", "codex", 4)]) expect(() => engine.acceptPolicy(current, next)).toThrow("STALE");
    expect(() => engine.acceptPolicy(current, scoped("server-a", "openclaw", 3, codex))).toThrow("CONFLICT");
    expect(() => engine.acceptPolicy(current, scoped("server-a", "codex", 4, { ...codex, chatHarness: "openclaw" }))).toThrow("CONFLICT");
  });
  it("migrates global revisions without permitting downgrade", () => {
    expect(engine.acceptPolicy(codex, scoped("server-a", null, 0, codex)).revision).toBe(0);
    expect(() => engine.acceptPolicy(codex, scoped())).toThrow("STALE");
    expect(() => engine.acceptPolicy(scoped(), native)).toThrow("DOWNGRADE");
  });
  it("strictly validates scoped shape and effective choice", () => {
    for (const patch of [{ revision: -1 }, { globalRevision: 0 }, { revision: 1.5 }, { serverId: "" }, { harnessOverride: undefined }, { harnessOverride: "auto" }, { chatHarness: "codex" }, { extra: true }]) expect(() => engine.parsePolicy({ ...scoped(), ...patch })).toThrow("INVALID");
  });
  it("has generated remote parity for scoped resolve/accept and normalization", () => {
    const policy = scoped("server-a", "codex", 2);
    const direct = fixture(), remote = fixture();
    engine.normalizeConfig(direct, policy);
    const result: unknown = runInNewContext(MANAGED_RUNTIME_FACTORY_SOURCE + "const e = createManagedRuntimePolicy(); e.assertPolicyServer(policy, 'server-a'); e.normalizeConfig(config, e.acceptPolicy(e.defaultPolicy, e.resolveAgentPolicy(e.defaultPolicy, {serverId:'server-a',harnessOverride:'codex',revision:2}))); policy;", { config: remote, policy, URL });
    expect(result).toEqual(policy); expect(remote).toEqual(direct);
  });
});

it("proves concrete API keys using canonical route scope without trusting mode metadata", () => {
  const config = fixture();
  expect(engine.hasPreparedApiKey(config, ref)).toBe(true);
  const source = { agents: { defaults: { models: { [ref]: { apiKey: "catalog-key" } } } }, models: { providers: { openai: { apiKey: "" } } } };
  expect(engine.hasPreparedApiKey(source, ref)).toBe(true);
  expect(engine.hasPreparedApiKey(source, ref, { scopeModels: { [ref]: { apiKey: "${UNRESOLVED}" } } })).toBe(false);
  expect(engine.hasPreparedApiKey({}, ref, { env: { OPENAI_API_KEY: " " } })).toBe(false);
  expect(engine.hasPreparedApiKey({ auth: { profiles: { stale: { provider: "openai", mode: "api_key" } } } }, ref)).toBe(false);
  const remote: unknown = runInNewContext(MANAGED_RUNTIME_FACTORY_SOURCE + "createManagedRuntimePolicy().hasPreparedApiKey(config, ref)", { config: source, ref, URL });
  expect(remote).toBe(true);
});

it("does not model-fence compaction/budgets but protects every conversational route scope", () => {
  const baseline = fixture();
  const operational = structuredClone(baseline);
  Object.assign(operational.agents.defaults, { compaction: { model: "openai/gpt-6-luna" }, timeoutSeconds: 7200, maxConcurrent: 4 });
  expect(engine.protectedRoute(operational)).toEqual(engine.protectedRoute(baseline));
  for (const key of ["model", "models", "params", "request", "headers", "baseUrl", "apiKey"]) {
    const changed = structuredClone(baseline);
    Object.assign(changed.agents.defaults, { [key]: { changed: true } });
    expect(engine.protectedRoute(changed)).not.toEqual(engine.protectedRoute(baseline));
  }
  for (const shape of ["list", "entries"]) {
    const initial = { ...baseline, agents: { ...baseline.agents, [shape]: shape === "list" ? [{ id: "worker", model: "openai/a" }] : { worker: { model: "openai/a" } } } };
    const changed = structuredClone(initial);
    Object.assign(changed.agents, { [shape]: shape === "list" ? [{ id: "worker", model: "openai/b" }] : { worker: { model: "openai/b" } } });
    expect(engine.protectedRoute(changed)).not.toEqual(engine.protectedRoute(initial));
  }
});
