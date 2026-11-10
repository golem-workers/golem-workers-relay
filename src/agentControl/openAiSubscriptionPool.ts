import { createHash } from "node:crypto";

export type PoolOAuthCredential = {
  type: "oauth";
  provider: "openai";
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};
export type SubscriptionPoolMember = {
  accountId: string;
  credentialVersion: number;
  enabled: boolean;
  credential: PoolOAuthCredential;
};
export type SubscriptionPoolState = {
  version: 1;
  revision: number;
  fingerprint: string;
  phase: "pending" | "applied";
  members: Array<{
    accountId: string;
    profileId: string;
    credentialVersion: number;
    enabled: boolean;
    credentialDigest: string;
  }>;
  /** Includes removals from an interrupted write, for deterministic reconciliation. */
  managedProfileIds: string[];
};
export class SubscriptionPoolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionPoolError";
  }
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function subscriptionProfileId(accountId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId))
    throw new SubscriptionPoolError(
      "OPENAI_POOL_ID_INVALID",
      "Invalid subscription account ID.",
    );
  return `openai:golem-${accountId}`;
}

/** Required by strict host adapters: no authored source of outer fallback, even
 * nested/subagent/cron policy. This read-only check never normalizes config. */
export function assertNoConfiguredFallbacks(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "fallback" || key === "fallbacks") && child != null &&
        !(Array.isArray(child) && child.length === 0) && child !== "") {
      throw new SubscriptionPoolError("OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN", "The loaded strict subscription-pool guard requires no configured model fallbacks. Remove fallbacks explicitly or update OpenClaw; model settings were not changed.");
    }
    assertNoConfiguredFallbacks(child);
  }
}

/** Never convert a preserved API key into OAuth material or silently rewrite models. */
export function assertSubscriptionOnlyConfiguration(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  guard?: { runScopedFallbacks: boolean },
): void {
  if (guard?.runScopedFallbacks === false) assertNoConfiguredFallbacks(config);
  const codex = object(object(object(object(config.plugins).entries).codex).config);
  const appServer = object(codex.appServer);
  if (appServer.homeScope === "user" || (appServer.transport !== undefined && appServer.transport !== "stdio") || appServer.url) {
    throw new SubscriptionPoolError("OPENAI_POOL_CODEX_AUTH_OWNER_UNSUPPORTED", "Subscription pools require the managed per-agent Codex auth bridge; native user-home or remote app-server auth is not pool-owned.");
  }
  const agents = object(config.agents),
    defaults = object(agents.defaults);
  const scopes = [
    defaults,
    ...(Array.isArray(agents.list) ? agents.list.map(object) : []),
    ...Object.values(object(agents.entries)).map(object),
  ];
  const providers = object(object(config.models).providers);
  for (const scope of scopes) {
    const assignment = scope.model ?? defaults.model;
    const model = object(assignment);
    if (!guard?.runScopedFallbacks && (
      (Array.isArray(model.fallbacks) && model.fallbacks.length) ||
      model.fallback
    )) {
      throw new SubscriptionPoolError(
        "OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN",
        "Remove model fallback explicitly before enabling subscription-only rotation.",
      );
    }
    const ref = typeof assignment === "string" ? assignment : model.primary;
    if (typeof ref !== "string" || !ref.startsWith("openai/"))
      throw new SubscriptionPoolError(
        "OPENAI_POOL_ROUTE_UNSUPPORTED",
        "Select an explicit OpenAI subscription model route before enabling the pool; Harness is unchanged.",
      );
    const provider = object(providers.openai);
    const row =
      (Array.isArray(provider.models) ? provider.models : [])
        .map(object)
        .find((r) => r.id === ref.slice(7)) ?? {};
    const catalog = {
      ...object(object(defaults.models)[ref]),
      ...object(object(scope.models)[ref]),
    };
    const route = { ...provider, ...row, ...catalog };
    if (
      route.api !== "openai-chatgpt-responses" ||
      [
        provider,
        row,
        catalog,
        defaults,
        scope,
        object(object(config.providers).openai),
      ].some((r) => r.apiKey !== undefined || r.auth !== undefined)
    ) {
      throw new SubscriptionPoolError(
        "OPENAI_POOL_ROUTE_UNSUPPORTED",
        "Subscription-only rotation requires an explicit ChatGPT Responses route without direct credential/auth overrides.",
      );
    }
    const environment = {
      ...env,
      ...object(config.env),
      ...object(object(config.env).vars),
    };
    const endpoint =
      route.baseUrl ??
      environment.OPENAI_BASE_URL ??
      "https://chatgpt.com/backend-api/codex";
    if (
      typeof endpoint !== "string" ||
      !/^https:\/\/chatgpt\.com\/backend-api\/codex\/?$/.test(endpoint)
    )
      throw new SubscriptionPoolError(
        "OPENAI_POOL_ROUTE_UNSUPPORTED",
        "Custom/API-key endpoints cannot be used by a subscription-only pool.",
      );
  }
}

export function prepareSubscriptionPool(
  previous: SubscriptionPoolState | null,
  revision: number,
  members: SubscriptionPoolMember[],
): SubscriptionPoolState {
  if (!Number.isSafeInteger(revision) || revision < 1 || members.length > 32)
    throw new SubscriptionPoolError(
      "OPENAI_POOL_INVALID",
      "Invalid subscription pool revision or size.",
    );
  const ids = members.map((m) => subscriptionProfileId(m.accountId));
  if (new Set(ids).size !== ids.length)
    throw new SubscriptionPoolError(
      "OPENAI_POOL_DUPLICATE",
      "Duplicate subscription account.",
    );
  for (const member of members) {
    if (
      member.credential.type !== "oauth" ||
      member.credential.provider !== "openai" ||
      !member.credential.access ||
      !member.credential.refresh ||
      !Number.isSafeInteger(member.credential.expires) ||
      !Number.isSafeInteger(member.credentialVersion) ||
      member.credentialVersion < 1
    )
      throw new SubscriptionPoolError(
        "OPENAI_POOL_INVALID",
        "Only versioned OpenAI OAuth credentials are allowed.",
      );
    const old = previous?.members.find((m) => m.accountId === member.accountId);
    if (
      old &&
      member.credentialVersion === old.credentialVersion &&
      createHash("sha256")
        .update(JSON.stringify(member.credential))
        .digest("hex") !== old.credentialDigest
    )
      throw new SubscriptionPoolError(
        "OPENAI_POOL_CREDENTIAL_CONFLICT",
        "Credential version was reused with different payload.",
      );
    if (old && member.credentialVersion < old.credentialVersion)
      throw new SubscriptionPoolError(
        "OPENAI_POOL_CREDENTIAL_STALE",
        "Credential version was superseded.",
      );
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        members.map((m) => ({ accountId: m.accountId, enabled: m.enabled })),
      ),
    )
    .digest("hex");
  if (
    previous &&
    (revision < previous.revision ||
      (revision === previous.revision && fingerprint !== previous.fingerprint))
  )
    throw new SubscriptionPoolError(
      "OPENAI_POOL_REVISION_CONFLICT",
      "Subscription membership revision was superseded or reused with different content.",
    );
  return {
    version: 1,
    revision,
    fingerprint,
    phase: "pending",
    members: members.map((m, i) => ({
      accountId: m.accountId,
      profileId: ids[i],
      credentialVersion: m.credentialVersion,
      enabled: m.enabled,
      credentialDigest: createHash("sha256")
        .update(JSON.stringify(m.credential))
        .digest("hex"),
    })),
    managedProfileIds: [
      ...new Set([...(previous?.managedProfileIds ?? []), ...ids]),
    ],
  };
}

export type PoolAuthStore = {
  profiles: Record<string, unknown>;
  order?: Record<string, string[]>;
  usageStats?: Record<string, unknown>;
  lastGood?: Record<string, string>;
};
/** Executed inside the public runtime's auth-store transaction, never direct SQL. */
export function updateSubscriptionPoolStore(
  store: PoolAuthStore,
  state: SubscriptionPoolState,
  members: SubscriptionPoolMember[],
): void {
  // Eliminate aliases of an explicitly adopted account: an old profile must
  // not retain refresh custody or become selectable through a session pin.
  // Unknown subscription profiles are not silently deleted or imported.
  const aliases: Array<[string, string]> = [];
  for (const [id, value] of Object.entries(store.profiles)) {
    const credential = value as { type?: string; provider?: string; accountId?: string } | null;
    // The runtime accepts token profiles on the ChatGPT route too. Preserve
    // them, but refuse activating a pool beside an unowned subscription source:
    // a stale-order repair or explicit pin must not select an unassigned account.
    if (credential?.type === "token" && ["openai", "openai-codex"].includes(credential.provider ?? ""))
      throw new Error("OPENAI_POOL_UNMANAGED_SUBSCRIPTION: explicitly remove or migrate OpenAI token profiles before enabling the pool.");
    if (
      state.managedProfileIds.includes(id) ||
      credential?.type !== "oauth" ||
      !["openai", "openai-codex"].includes(credential.provider ?? "")
    )
      continue;
    const index = members.findIndex(
      (m) =>
        Boolean(m.credential.accountId) &&
        m.credential.accountId === credential.accountId,
    );
    if (index < 0)
      throw new Error(
        "OPENAI_POOL_UNMANAGED_SUBSCRIPTION: explicitly adopt existing subscription profiles before enabling the pool.",
      );
    aliases.push([id, state.members[index].profileId]);
  }
  for (const [alias, target] of aliases) {
    if (store.usageStats?.[alias] && !store.usageStats[target])
      store.usageStats[target] = store.usageStats[alias];
    if (store.lastGood?.openai === alias) store.lastGood.openai = target;
    delete store.profiles[alias];
    if (store.usageStats) delete store.usageStats[alias];
  }
  const retained = new Set(
    state.members.filter((m) => m.enabled).map((m) => m.profileId),
  );
  for (const id of state.managedProfileIds)
    if (!retained.has(id)) {
      delete store.profiles[id];
      if (store.usageStats) delete store.usageStats[id];
    }
  // Refresh custody belongs to the backend's per-account lease. Distributing a
  // rotating refresh token to N machines lets one machine invalidate every
  // other copy. Access-only OAuth remains an OAuth subscription route; once it
  // expires the runtime fails closed until the next acknowledged refresh.
  // The shared machine store is inherited even by the main agent. Access-only
  // profiles must be portable or a fresh native agent sees no subscription.
  // No refresh custody is inherited; removal stays authoritative in this store.
  for (const [index, member] of members.entries()) {
    if (member.enabled)
      store.profiles[state.members[index].profileId] = {
        ...member.credential,
        refresh: "",
        copyToAgents: true,
      };
  }
  const enabled = state.members
    .filter((m) => m.enabled)
    .map((m) => m.profileId);
  store.order = { ...store.order, openai: enabled };
  if (store.lastGood?.openai && !enabled.includes(store.lastGood.openai))
    delete store.lastGood.openai;
}
