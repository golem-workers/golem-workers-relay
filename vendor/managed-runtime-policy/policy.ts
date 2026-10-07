/** Canonical source. Generated consumers must not be edited. Pure, dependency-free,
 * deliberately enclosed in one factory so remote serialization includes every dependency. */
export type ManagedHarness = "openclaw" | "codex";
export type GlobalManagedRuntimePolicy = { schemaVersion: 1; revision: number; chatHarness: ManagedHarness };
export type AgentManagedRuntimePolicy = { schemaVersion: 2; serverId: string; globalRevision: number; revision: number; harnessOverride: ManagedHarness | null; defaultHarness: ManagedHarness; chatHarness: ManagedHarness };
export type ManagedRuntimePolicy = GlobalManagedRuntimePolicy | AgentManagedRuntimePolicy;
export type RuntimeContext = { env?: Record<string, unknown>; subscriptionAuth?: boolean; apiKeyAuth?: boolean; params?: Record<string, unknown>; scopeModels?: Record<string, unknown>; scope?: Record<string, unknown> };
export function createManagedRuntimePolicy() {
  type Row = Record<string, unknown>;
  const record = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
  const ensure = (parent: Row, key: string): Row => record(parent[key]) ?? (parent[key] = {}) as Row;
  const defaultPolicy: GlobalManagedRuntimePolicy = { schemaVersion: 1, revision: 1, chatHarness: "openclaw" };
  function parsePolicy(value: unknown): ManagedRuntimePolicy {
    const row = record(value);
    const harness = (value: unknown): value is ManagedHarness => value === "openclaw" || value === "codex";
    const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;
    if (row?.schemaVersion === 1 && integer(row.revision, 1) && harness(row.chatHarness) && Object.keys(row).every(key => ["schemaVersion", "revision", "chatHarness"].includes(key))) return { schemaVersion: 1, revision: Number(row.revision), chatHarness: row.chatHarness };
    if (row?.schemaVersion === 2 && typeof row.serverId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.serverId) && integer(row.globalRevision, 1) && integer(row.revision, 0) && (row.harnessOverride === null || harness(row.harnessOverride)) && harness(row.defaultHarness) && harness(row.chatHarness) && row.chatHarness === (row.harnessOverride ?? row.defaultHarness) && Object.keys(row).every(key => ["schemaVersion", "serverId", "globalRevision", "revision", "harnessOverride", "defaultHarness", "chatHarness"].includes(key))) return { schemaVersion: 2, serverId: row.serverId, globalRevision: Number(row.globalRevision), revision: Number(row.revision), harnessOverride: row.harnessOverride, defaultHarness: row.defaultHarness, chatHarness: row.chatHarness };
    throw new Error("MANAGED_RUNTIME_POLICY_INVALID");
  }
  function assertPolicyServer(policy: ManagedRuntimePolicy, serverId: string | undefined): void {
    if (policy.schemaVersion === 2 && (!serverId || policy.serverId !== serverId)) throw new Error("MANAGED_RUNTIME_POLICY_SERVER_MISMATCH");
  }
  function resolveAgentPolicy(global: GlobalManagedRuntimePolicy, agent: { serverId: string; harnessOverride: ManagedHarness | null; revision: number }): AgentManagedRuntimePolicy {
    const parsed = parsePolicy(global);
    if (parsed.schemaVersion !== 1) throw new Error("MANAGED_RUNTIME_GLOBAL_POLICY_REQUIRED");
    return parsePolicy({ schemaVersion: 2, serverId: agent.serverId, globalRevision: parsed.revision, revision: agent.revision, harnessOverride: agent.harnessOverride, defaultHarness: parsed.chatHarness, chatHarness: agent.harnessOverride ?? parsed.chatHarness }) as AgentManagedRuntimePolicy;
  }
  function acceptPolicy(current: ManagedRuntimePolicy, incoming: ManagedRuntimePolicy): ManagedRuntimePolicy {
    current = parsePolicy(current); incoming = parsePolicy(incoming);
    if (current.schemaVersion === 2) {
      if (incoming.schemaVersion !== 2) throw new Error("MANAGED_RUNTIME_POLICY_DOWNGRADE");
      assertPolicyServer(incoming, current.serverId);
      if (incoming.globalRevision < current.globalRevision || incoming.revision < current.revision) throw new Error("MANAGED_RUNTIME_POLICY_STALE");
      if ((incoming.revision === current.revision && incoming.harnessOverride !== current.harnessOverride) || (incoming.globalRevision === current.globalRevision && incoming.defaultHarness !== current.defaultHarness)) throw new Error("MANAGED_RUNTIME_POLICY_CONFLICT");
    } else {
      const globalRevision = incoming.schemaVersion === 1 ? incoming.revision : incoming.globalRevision;
      const defaultHarness = incoming.schemaVersion === 1 ? incoming.chatHarness : incoming.defaultHarness;
      if (globalRevision < current.revision) throw new Error("MANAGED_RUNTIME_POLICY_STALE");
      if (globalRevision === current.revision && defaultHarness !== current.chatHarness) throw new Error("MANAGED_RUNTIME_POLICY_CONFLICT");
    }
    return incoming;
  }
  function policyFromEnvironment(env: Record<string, unknown>): GlobalManagedRuntimePolicy {
    return parsePolicy({ schemaVersion: 1, revision: Number(env.MANAGED_AGENT_HARNESS_POLICY_REVISION ?? 1), chatHarness: env.MANAGED_AGENT_HARNESS ?? "openclaw" }) as GlobalManagedRuntimePolicy;
  }
  function profiles(config: Row): Row[] { return Object.values(record(record(config.auth)?.profiles) ?? {}).map(record).filter((row): row is Row => Boolean(row)); }
  function environment(config: Row, context: RuntimeContext): Row {
    return { ...(context.env ?? {}), ...(record(config.env) ?? {}), ...(record(record(config.env)?.vars) ?? {}) };
  }
  function modelParts(ref: string) {
    const slash = ref.indexOf("/"); return { provider: ref.slice(0, slash).toLowerCase(), model: ref.slice(slash + 1) };
  }
  function route(config: Row, ref: string, context: RuntimeContext) {
    const { provider, model } = modelParts(ref);
    const providers = record(record(config.models)?.providers) ?? {};
    const providerRow = record(providers[provider]) ?? record(providers.openai) ?? {};
    const legacy = record(record(config.providers)?.[provider]) ?? {};
    const modelRow = (Array.isArray(providerRow.models) ? providerRow.models : []).map(record).find(row => row?.id === model) ?? {};
    const env = environment(config, context);
    const catalog = record(record(record(config.agents)?.defaults)?.models);
    const defaultsScope = record(record(config.agents)?.defaults) ?? {};
    const agentScope = context.scope ?? { params: context.params };
    const rows = [legacy, providerRow, modelRow, record(catalog?.[ref]) ?? {}, defaultsScope, agentScope, record(context.scopeModels?.[ref]) ?? {}];
    const authored = (key: string): unknown => { for (const row of [...rows].reverse()) if (row[key] !== undefined) return row[key]; return undefined; };
    const hasApiKey = context.apiKeyAuth || env.OPENAI_API_KEY !== undefined || env.CODEX_API_KEY !== undefined || authored("apiKey") !== undefined || (context.apiKeyAuth === undefined && profiles(config).some(row => ["openai", "codex", "openai-codex"].includes(String(row.provider)) && ["api_key", "api-key"].includes(String(row.mode))));
    // Readiness proof is deliberately stricter than route metadata presence.
    const keyValue = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && !value.includes("${");
    const preparedApiKey = Boolean(context.apiKeyAuth || keyValue(env.OPENAI_API_KEY) || keyValue(env.CODEX_API_KEY) || keyValue(authored("apiKey")));
    const hasSubscription = context.subscriptionAuth || (context.subscriptionAuth === undefined && profiles(config).some(row => ["openai", "codex", "openai-codex"].includes(String(row.provider)) && ["oauth", "token"].includes(String(row.mode))));
    const api = authored("api") ?? (hasSubscription && !hasApiKey ? "openai-chatgpt-responses" : "openai-responses");
    const baseUrl = authored("baseUrl") ?? env.OPENAI_BASE_URL ?? (api === "openai-chatgpt-responses" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1");
    function reproducibleParams(value: unknown): boolean {
      if (value === undefined) return true;
      const params = record(value); if (!params) return false;
      return Object.entries(params).every(([key, value]) => ["fastMode", "fast_mode"].includes(key) ? [true, false, "auto"].includes(value as boolean | string) : ["fastAutoOnSeconds", "fast_auto_on_seconds", "fastSeconds", "fast_seconds"].includes(key) && typeof value === "number" && Number.isFinite(value) && value > 0);
    }
    const overrides = rows.some(row => ["headers", "requestTransportOverrides", "requestOptions", "fetch", "transport", "request", "localService", "authHeader", "timeoutSeconds", "compat"].some(key => !(key === "timeoutSeconds" && (row === defaultsScope || row === agentScope)) && row[key] !== undefined && row[key] !== "none" && !(record(row[key]) && Object.keys(record(row[key])!).length === 0)) || !reproducibleParams(row.params));
    return { provider, model, api, baseUrl, overrides, preparedApiKey, hasApiKey: Boolean(hasApiKey), hasSubscription: Boolean(hasSubscription) };
  }
  function hasPreparedApiKey(config: Row, ref: string, context: RuntimeContext = {}): boolean {
    return route(config, ref, context).preparedApiKey;
  }
  function codexCompatibility(config: Row, ref: string, context: RuntimeContext = {}): { supported: boolean; reason?: string } {
    const info = route(config, ref, context);
    const deny = (reason: string) => ({ supported: false, reason });
    if (!["openai", "codex", "openai-codex"].includes(info.provider)) return deny("provider does not support Codex");
    if (!/^(?:gpt-(?:4|5|6)(?:[.-]|$)|o[134](?:[-.]|$)|chatgpt-)/i.test(info.model) || /(?:image|embedding|audio|tts|transcrib|realtime|sora)/i.test(info.model)) return deny("model is not an eligible conversational/image-understanding model");
    if (info.overrides) return deny("authored request transport overrides cannot be reproduced by Codex");
    try {
      if (typeof info.baseUrl !== "string") return deny("invalid provider endpoint");
      const url = new URL(info.baseUrl);
      if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return deny("route must be an exact official HTTPS endpoint");
      const platform = url.hostname === "api.openai.com" && ["/", "/v1", "/v1/"].includes(url.pathname);
      const chatgpt = url.hostname === "chatgpt.com" && /^\/backend-api(?:\/(?:v1|codex(?:\/(?:v1|responses))?))?\/?$/.test(url.pathname);
      if (!(platform && info.api === "openai-responses") && !(chatgpt && info.api === "openai-chatgpt-responses")) return deny("authored/custom or incompatible provider route cannot be reproduced by Codex");
      if (platform && !info.hasApiKey) return deny("prepared OpenAI API-key authentication is required");
      if (chatgpt && !info.hasSubscription) return deny("prepared ChatGPT OAuth/token authentication is required");
    } catch { return deny("invalid provider endpoint"); }
    return { supported: true };
  }
  function isSubscriptionRoute(config: Row, ref: string, context: RuntimeContext = {}): boolean {
    const info = route(config, ref, context);
    return info.api === "openai-chatgpt-responses" && info.hasSubscription;
  }
  function expectedRuntime(config: Row, ref: string, purpose: string, policy: ManagedRuntimePolicy, context: RuntimeContext = {}): "openclaw" | "codex" {
    if (parsePolicy(policy).chatHarness === "openclaw" || !["main", "image", "pdf"].includes(purpose)) return "openclaw";
    const result = codexCompatibility(config, ref, context);
    if (!result.supported && purpose !== "main") return "openclaw"; // Explicit native auxiliary-provider scope, not a chat fallback.
    if (!result.supported) throw new Error(`MANAGED_CODEX_INCOMPATIBLE: ${ref} (${purpose}): ${result.reason}`);
    return "codex";
  }
  /** Sol catalog augmentation never replaces authored transport/auth or injects an API
   * into an authored endpoint without an explicit API contract. */
  function ensureSolCompatibility(config: Row, subscriptionRoute = false, context: RuntimeContext = {}): void {
    const defaults = record(record(config.agents)?.defaults);
    const catalog = record(defaults?.models);
    if (!record(catalog?.["openai/gpt-6.1-sol"])) return;
    const provider = ensure(ensure(ensure(config, "models"), "providers"), "openai");
    provider.agentRuntime ??= { id: "openclaw" };
    const models: unknown[] = Array.isArray(provider.models) ? provider.models : [];
    provider.models = models;
    let model = models.map(record).find(row => row?.id === "gpt-6.1-sol");
    if (!model) { model = { id: "gpt-6.1-sol" }; models.push(model); }
    const env = environment(config, context);
    const hasAuthoredRoute = [provider, model, record(record(config.providers)?.openai) ?? {}].some(row => ["api", "baseUrl", "apiKey", "auth", "headers"].some(key => row[key] !== undefined)) || env.OPENAI_BASE_URL !== undefined;
    const values: Row = { name: "GPT-6.1-Sol", reasoning: true, input: ["text", "image"], contextWindow: 272000, cost: { input: 2, output: 10 }, agentRuntime: { id: "openclaw" } };
    const apiKeyIntent = Boolean(context.apiKeyAuth || env.OPENAI_API_KEY !== undefined || env.CODEX_API_KEY !== undefined || profiles(config).some(row => ["openai", "codex", "openai-codex"].includes(String(row.provider)) && ["api_key", "api-key"].includes(String(row.mode))));
    if (!hasAuthoredRoute) values.api = subscriptionRoute && !apiKeyIntent ? "openai-chatgpt-responses" : "openai-responses";
    for (const [key, value] of Object.entries(values)) if (model[key] === undefined) model[key] = value;
  }
  function needsAuthContext(config: Row, policy: ManagedRuntimePolicy): boolean {
    if (policy.chatHarness === "codex") return true;
    const catalog = record(record(record(config.agents)?.defaults)?.models);
    if (!record(catalog?.["openai/gpt-6.1-sol"])) return false;
    const provider = record(record(record(config.models)?.providers)?.openai) ?? {};
    const model = (Array.isArray(provider.models) ? provider.models as unknown[] : []).map(record).find(row => row?.id === "gpt-6.1-sol") ?? {};
    return [provider, model, record(record(config.providers)?.openai) ?? {}].every(row => ["api", "baseUrl", "apiKey", "auth", "headers"].every(key => row[key] === undefined));
  }
  function assignmentRefs(value: unknown): string[] {
    const row = record(value);
    return (typeof value === "string" ? [value] : row ? [row.primary, ...(Array.isArray(row.fallbacks) ? row.fallbacks as unknown[] : []), row.fallback] : []).filter((ref): ref is string => typeof ref === "string" && Boolean(ref.trim())).map(ref => ref.trim());
  }
  /** Preflight on a clone: rejection never partially mutates the caller's config. */
  function normalizeConfig(config: Row, policy: ManagedRuntimePolicy = defaultPolicy, context: RuntimeContext = {}): void {
    policy = parsePolicy(policy);
    const next = JSON.parse(JSON.stringify(config)) as Row;
    const originalAgents = record(next.agents) ?? {};
    const originalScopes = [record(originalAgents.defaults), ...(Array.isArray(originalAgents.list) ? originalAgents.list as unknown[] : []).map(record), ...Object.values(record(originalAgents.entries) ?? {}).map(record)].filter((row): row is Row => Boolean(row));
    if (next.models === undefined && !originalScopes.some(row => Object.keys(row).some(key => key === "models" || key === "model" || key.endsWith("Model")))) return;
    const agents = ensure(next, "agents"), defaults = ensure(agents, "defaults"), catalog = ensure(defaults, "models");
    const subscription = Boolean(context.subscriptionAuth || profiles(next).some(row => row.mode === "oauth" && ["openai", "codex", "openai-codex"].includes(String(row.provider))));
    ensureSolCompatibility(next, subscription, context);
    const scopes = [defaults, ...(Array.isArray(agents.list) ? agents.list : []).map(record).filter((row): row is Row => Boolean(row)), ...Object.values(record(agents.entries) ?? {}).map(record).filter((row): row is Row => Boolean(row))];
    const uses = new Map<string, Set<string>>();
    const keys: Record<string, string> = { model: "main", imageModel: "image", pdfModel: "pdf", imageGenerationModel: "imageGeneration", videoGenerationModel: "videoGeneration", musicGenerationModel: "musicGeneration", embeddingModel: "embedding", audioTranscriptionModel: "audioTranscription" };
    for (const scope of scopes) for (const [key, purpose] of Object.entries({ ...Object.fromEntries(Object.keys({ ...defaults, ...scope }).filter(key => key.endsWith("Model")).map(key => [key, "auxiliary"])), ...keys })) for (const ref of assignmentRefs(scope[key] ?? (scope === defaults ? undefined : defaults[key]))) {
      const runtime = expectedRuntime(next, ref, purpose, policy, { ...context, params: record(scope.params), scopeModels: record(scope.models), scope });
      const set = uses.get(ref) ?? new Set<string>(); set.add(runtime); uses.set(ref, set);
      if (set.size > 1) throw new Error(`MANAGED_RUNTIME_PURPOSE_CONFLICT: ${ref} is shared by conversational and native-only media purposes`);
      ensure(catalog, ref);
    }
    function runtimeFor(ref: string): "openclaw" | "codex" {
      const used = uses.get(ref); if (used) return [...used][0] as "openclaw" | "codex";
      return policy.chatHarness === "codex" && codexCompatibility(next, ref, context).supported ? "codex" : "openclaw";
    }
    for (const scope of scopes) {
      const models = record(scope.models);
      for (const [ref, value] of Object.entries(models ?? {})) {
        const entry = record(value); if (!entry) continue;
        const runtime = runtimeFor(ref); entry.agentRuntime = { id: runtime };
        if (Array.isArray(entry.pickerRuntimes)) entry.pickerRuntimes = [runtime];
      }
    }
    for (const [providerId, value] of Object.entries(record(record(next.models)?.providers) ?? {})) {
      const provider = record(value); if (!provider) continue;
      // A provider-wide Codex default would capture unsupported models/purposes.
      provider.agentRuntime = { id: "openclaw" };
      if (Array.isArray(provider.pickerRuntimes)) provider.pickerRuntimes = ["openclaw"];
      for (const value of Array.isArray(provider.models) ? provider.models : []) {
        const model = record(value); if (!model || typeof model.id !== "string") continue;
        const runtime = runtimeFor(providerId + "/" + model.id); model.agentRuntime = { id: runtime };
        if (Array.isArray(model.pickerRuntimes)) model.pickerRuntimes = [runtime];
      }
    }
    function commit(target: Row, source: Row): void {
      for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
      for (const [key, value] of Object.entries(source)) {
        const prior = record(target[key]), row = record(value);
        if (prior && row) commit(prior, row);
        else if (Array.isArray(target[key]) && Array.isArray(value)) {
          const array = target[key] as unknown[];
          const items: unknown[] = (value as unknown[]).map((item: unknown, index: number) => { const old = record(array[index]), next = record(item); if (old && next) { commit(old, next); return old; } return item; });
          array.splice(0, array.length, ...items);
        } else target[key] = value;
      }
    }
    commit(config, next);
  }
  /** Model fence protects model assignments/catalogs, provider routes and auth.
   * Operational agent settings (including compaction) use whole-config CAS,
   * not the model-selection fence. Runtime metadata has its separate invariant. */
  function protectedRoute(config: Row): unknown {
    const next = JSON.parse(JSON.stringify({ agents: config.agents, providers: config.models, legacyProviders: config.providers, auth: config.auth, env: config.env })) as Row;
    const strip = (row: Row) => { delete row.agentRuntime; delete row.pickerRuntimes; };
    const sourceAgents = record(next.agents) ?? {};
    const project = (value: unknown): Row | undefined => {
      const scope = record(value);
      if (!scope) return undefined;
      return Object.fromEntries(Object.entries(scope).filter(([key]) => ["id", "model", "models", "params", "api", "baseUrl", "apiKey", "auth", "headers", "requestTransportOverrides", "requestOptions", "fetch", "transport", "request", "localService", "authHeader", "compat"].includes(key) || key.endsWith("Model")));
    };
    const agents: Row = {};
    if (sourceAgents.defaults !== undefined) agents.defaults = project(sourceAgents.defaults);
    if (Array.isArray(sourceAgents.list)) agents.list = sourceAgents.list.map(project);
    if (record(sourceAgents.entries)) agents.entries = Object.fromEntries(Object.entries(sourceAgents.entries as Row).map(([id, scope]) => [id, project(scope)]));
    next.agents = agents;
    for (const scope of [record(agents.defaults), ...(Array.isArray(agents.list) ? agents.list : []).map(record), ...Object.values(record(agents.entries) ?? {}).map(record)].filter((row): row is Row => Boolean(row))) {
      for (const entry of Object.values(record(scope.models) ?? {}).map(record)) if (entry) strip(entry);
    }
    for (const provider of Object.values(record(record(next.providers)?.providers) ?? {}).map(record)) if (provider) {
      strip(provider); for (const model of (Array.isArray(provider.models) ? provider.models : []).map(record)) if (model) strip(model);
    }
    return next;
  }
  function assertRuntimeMetadata(config: Row, policy: ManagedRuntimePolicy, context: RuntimeContext = {}): void {
    const expected = JSON.parse(JSON.stringify(config)) as Row;
    normalizeConfig(expected, policy, context);
    function check(value: unknown, normalized: unknown): void {
      if (Array.isArray(value)) { value.forEach((entry, index) => check(entry, Array.isArray(normalized) ? normalized[index] : undefined)); return; }
      const row = record(value), wanted = record(normalized); if (!row) return;
      for (const [key, entry] of Object.entries(row)) {
        if ((key === "agentRuntime" || key === "pickerRuntimes") && wanted?.[key] !== undefined && JSON.stringify(entry) !== JSON.stringify(wanted[key])) throw new Error("MANAGED_RUNTIME_METADATA_CONFLICT");
        else check(entry, wanted?.[key]);
      }
    }
    check(config, expected);
  }
  return { defaultPolicy, parsePolicy, assertPolicyServer, resolveAgentPolicy, acceptPolicy, policyFromEnvironment, hasPreparedApiKey, codexCompatibility, isSubscriptionRoute, expectedRuntime, ensureSolCompatibility, needsAuthContext, normalizeConfig, protectedRoute, assertRuntimeMetadata };
}

/** Read-only offline auth proof. Shared machine ownership excludes stale agent JSON. */
export function readOfflineRuntimeAuth(configPath: string): RuntimeContext {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  type Row = Record<string, unknown>;
  const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  const root = path.dirname(configPath);
  const sharedPath = path.join(root, "state/openclaw.sqlite");
  const agentPath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
  let shared = false;
  const credentials: unknown[] = [];
  if (fs.existsSync(sharedPath)) {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(sharedPath, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config_machine_state'").get()) {
        const ownership = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='auth.sharedStore'").get() as { value_json?: string } | undefined;
        shared = row(JSON.parse(ownership?.value_json ?? "null")).location === "state-db";
        if (shared) {
          const store = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'").get() as { value_json?: string } | undefined;
          credentials.push(...Object.values(row(row(JSON.parse(store?.value_json ?? "null")).profiles)));
        }
      }
    } finally { db.close(); }
  }
  if (!shared) {
    if (fs.existsSync(agentPath)) {
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const db = new DatabaseSync(agentPath, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_profile_store'").get()) {
          const store = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key='primary'").get() as { store_json?: string } | undefined;
          credentials.push(...Object.values(row(row(JSON.parse(store?.store_json ?? "null")).profiles)));
        }
      } finally { db.close(); }
    }
    for (const file of [path.join(root, "auth-profiles.json"), path.join(root, "agents/main/agent/auth-profiles.json")]) if (fs.existsSync(file)) credentials.push(...Object.values(row(row(JSON.parse(fs.readFileSync(file, "utf8"))).profiles)));
  }
  const openai = credentials.map(row).filter(value => ["openai", "openai-codex", "codex"].includes(String(value.provider)));
  return { subscriptionAuth: openai.some(value => value.type === "oauth" && !["chatgpt-identity", "chatgpt-token-sharing"].includes(String(value.authFlow))), apiKeyAuth: openai.some(value => value.type === "api_key") };
}
