import { describe, expect, it } from "vitest";
import {
  assertSubscriptionOnlyConfiguration,
  prepareSubscriptionPool,
  updateSubscriptionPoolStore,
  type PoolAuthStore,
  type SubscriptionPoolMember,
} from "./openAiSubscriptionPool.js";
const member = (
  accountId: string,
  credentialVersion = 1,
): SubscriptionPoolMember => ({
  accountId,
  credentialVersion,
  enabled: true,
  credential: {
    type: "oauth",
    provider: "openai",
    access: `synthetic-${accountId}`,
    refresh: "synthetic-refresh",
    expires: 4700000000000,
  },
});
const config = () => ({
  agents: {
    defaults: { model: { primary: "openai/gpt-6.1-sol", fallbacks: [] } },
  },
  models: {
    providers: { openai: { api: "openai-chatgpt-responses", models: [] } },
  },
});
describe("subscription-only pool", () => {
  it("preserves other accounts/providers and healthy cooldown/sticky metadata on add/refresh/reorder", () => {
    const a = member("a"),
      b = member("b"),
      first = prepareSubscriptionPool(null, 1, [a]);
    const store: PoolAuthStore = {
      profiles: {
        "openai:key": { type: "api_key", key: "synthetic" },
        "anthropic:keep": {},
      },
      usageStats: { "openai:golem-a": { blockedUntil: 4700000000000 } },
      lastGood: { openai: "openai:golem-a" },
    };
    updateSubscriptionPoolStore(store, first, [a]);
    const next = prepareSubscriptionPool(first, 2, [b, member("a", 2)]);
    updateSubscriptionPoolStore(store, next, [b, member("a", 2)]);
    expect(Object.keys(store.profiles)).toHaveLength(4);
    expect(store.profiles["openai:golem-a"]).toMatchObject({
      type: "oauth",
      refresh: "",
      copyToAgents: true,
    });
    expect(store.order?.openai).toEqual(["openai:golem-b", "openai:golem-a"]);
    expect(store.lastGood?.openai).toBe("openai:golem-a");
    expect(store.usageStats?.["openai:golem-a"]).toEqual({
      blockedUntil: 4700000000000,
    });
  });
  it("removes only the intended account and leaves an explicit empty order after last disconnect", () => {
    const a = member("a"),
      b = member("b");
    let state = prepareSubscriptionPool(null, 1, [a, b]);
    const store: PoolAuthStore = { profiles: { "openai:unmanaged": {} } };
    updateSubscriptionPoolStore(store, state, [a, b]);
    state = prepareSubscriptionPool(state, 2, [b]);
    updateSubscriptionPoolStore(store, state, [b]);
    expect(store.profiles["openai:golem-a"]).toBeUndefined();
    expect(store.profiles["openai:golem-b"]).toBeDefined();
    state = prepareSubscriptionPool(state, 3, []);
    updateSubscriptionPoolStore(store, state, []);
    expect(store.order?.openai).toEqual([]);
    expect(store.profiles["openai:unmanaged"]).toEqual({});
  });
  it("refuses stale revisions, duplicate accounts and stale credentials, and allows identical replay", () => {
    const a = member("a", 2),
      state = prepareSubscriptionPool(null, 5, [a]);
    expect(prepareSubscriptionPool(state, 5, [a]).fingerprint).toBe(
      state.fingerprint,
    );
    expect(() => prepareSubscriptionPool(state, 4, [a])).toThrow(/superseded/);
    expect(() => prepareSubscriptionPool(state, 5, [member("b")])).toThrow(
      /different content/,
    );
    expect(() => prepareSubscriptionPool(state, 6, [member("a", 1)])).toThrow(
      /Credential version/,
    );
    expect(() => prepareSubscriptionPool(null, 1, [a, a])).toThrow(/Duplicate/);
  });
  it("allows a dormant API key only on an explicitly authored subscription route", () => {
    const input = config(),
      before = structuredClone(input);
    expect(() =>
      assertSubscriptionOnlyConfiguration(input, {
        OPENAI_API_KEY: "synthetic",
      }),
    ).not.toThrow();
    expect(input).toEqual(before);
    expect(() =>
      assertSubscriptionOnlyConfiguration(
        {
          ...input,
          models: {
            providers: {
              openai: { ...input.models.providers.openai, auth: "oauth" },
            },
          },
        },
        {},
      ),
    ).toThrow(/without direct/);
    expect(() =>
      assertSubscriptionOnlyConfiguration(
        {
          ...input,
          models: { providers: { openai: { api: "openai-responses" } } },
        },
        {},
      ),
    ).toThrow(/Subscription-only/);
    expect(() =>
      assertSubscriptionOnlyConfiguration(input, {
        OPENAI_BASE_URL: "https://api.openai.com/v1",
      }),
    ).toThrow(/endpoints/);
  });
  it("refuses model fallback before any auth/config mutation and does not force a Harness", () => {
    const input = config();
    input.agents.defaults.model.fallbacks.push("openai/other");
    const before = structuredClone(input);
    expect(() => assertSubscriptionOnlyConfiguration(input, {})).toThrow(
      /Remove model fallback explicitly/,
    );
    expect(input).toEqual(before);
  });
});

describe("pool allowlist is not bypassed by retained OAuth aliases", () => {
  it("adopts only the same account identity, preserving cooldown metadata", () => {
    const a = {
      ...member("a"),
      credential: { ...member("a").credential, accountId: "workspace-a" },
    };
    const store: PoolAuthStore = {
      profiles: {
        "openai:old-email": { ...a.credential, refresh: "old-refresh" },
        "openai:key": { type: "api_key", provider: "openai", key: "synthetic" },
      },
      usageStats: { "openai:old-email": { cooldownUntil: 4700000000000 } },
      lastGood: { openai: "openai:old-email" },
    };
    updateSubscriptionPoolStore(store, prepareSubscriptionPool(null, 1, [a]), [
      a,
    ]);
    expect(store.profiles["openai:old-email"]).toBeUndefined();
    expect(store.profiles["openai:golem-a"]).toMatchObject({
      refresh: "",
      copyToAgents: true,
    });
    expect(store.usageStats?.["openai:golem-a"]).toEqual({
      cooldownUntil: 4700000000000,
    });
    expect(store.lastGood?.openai).toBe("openai:golem-a");
  });
  it("refuses an unassigned OAuth account before changing the store", () => {
    const store: PoolAuthStore = {
      profiles: {
        "openai:unknown": {
          type: "oauth",
          provider: "openai",
          accountId: "other",
          access: "synthetic",
          refresh: "synthetic",
        },
      },
    };
    const before = structuredClone(store);
    expect(() =>
      updateSubscriptionPoolStore(
        store,
        prepareSubscriptionPool(null, 1, [member("a")]),
        [member("a")],
      ),
    ).toThrow(/UNMANAGED_SUBSCRIPTION/);
    expect(store).toEqual(before);
  });
  it("does not leave disabled credentials selectable through a manually pinned profile", () => {
    const a = member("a"),
      b = member("b"),
      old = prepareSubscriptionPool(null, 1, [a, b]);
    const store: PoolAuthStore = { profiles: {} };
    updateSubscriptionPoolStore(store, old, [a, b]);
    const disabled = { ...a, enabled: false };
    updateSubscriptionPoolStore(
      store,
      prepareSubscriptionPool(old, 2, [disabled, b]),
      [disabled, b],
    );
    expect(store.profiles["openai:golem-a"]).toBeUndefined();
    expect(store.order?.openai).toEqual(["openai:golem-b"]);
  });
});


it.each(["openai", "openai-codex"])("refuses an unowned %s token profile before any store mutation", provider => {
  const a = member("a");
  a.credential.accountId = "workspace-a";
  const store: PoolAuthStore = {profiles:{
    "openai:old-a": {...a.credential, accountId:"workspace-a"},
    "openai:foreign-token": {type:"token",provider,token:"synthetic-token"},
    "openai:api": {type:"api_key",provider:"openai",key:"synthetic-api"},
    "anthropic:keep": {type:"token",provider:"anthropic",token:"synthetic-other"},
  },order:{openai:["openai:foreign-token"]}};
  const before = structuredClone(store);
  expect(() => updateSubscriptionPoolStore(store, prepareSubscriptionPool(null,1,[a]), [a])).toThrow(/OPENAI_POOL_UNMANAGED_SUBSCRIPTION/);
  expect(store).toEqual(before);
});

it.each([{homeScope:"user"},{transport:"websocket",url:"ws://127.0.0.1:1234"},{transport:"unix"}])("refuses a non-pool Codex credential owner before authorization effects (%j)", appServer => {
  expect(() => assertSubscriptionOnlyConfiguration({plugins:{entries:{codex:{config:{appServer}}}}})).toThrow("managed per-agent Codex auth bridge");
});
