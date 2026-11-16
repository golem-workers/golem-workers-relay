import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const writer = vi.hoisted(() => vi.fn());
vi.mock("./runtimeAuthWriter.js", () => ({ writeRuntimeAuthPool: writer }));
import {
  readSubscriptionPoolState,
  syncSubscriptionPool,
  assertLegacyAuthMutationAllowed,
} from "./subscriptionPoolManager.js";
const roots: string[] = [];
afterEach(async () => {
  writer.mockReset();
  await Promise.all(
    roots.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});
const members = [
  {
    accountId: "a",
    enabled: true,
    credentialVersion: 1,
    credential: {
      type: "oauth" as const,
      provider: "openai" as const,
      access: "synthetic",
      refresh: "synthetic",
      expires: 4700000000000,
    },
  },
];
async function fixture(fallbacks: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-manager-"));
  roots.push(root);
  const configPath = path.join(root, "openclaw.json");
  const text = JSON.stringify({
    agents: {
      defaults: { model: { primary: "openai/gpt-6.1-sol", fallbacks } },
    },
    models: { providers: { openai: { api: "openai-chatgpt-responses" } } },
  });
  await fs.writeFile(configPath, text);
  return { configPath, text };
}
describe("subscription pool durable ack", () => {
  it("keeps an interrupted refresh pending, blocks legacy writers, and reconciles exact replay", async () => {
    const { configPath, text } = await fixture();
    writer.mockResolvedValue(undefined);
    await expect(
      syncSubscriptionPool({
        assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }),
        configPath,
        revision: 1,
        members,
        refreshRuntimeAuth: () => Promise.reject(new Error("offline")),
      }),
    ).rejects.toThrow("offline");
    expect((await readSubscriptionPoolState(configPath))?.phase).toBe(
      "pending",
    );
    await expect(assertLegacyAuthMutationAllowed(configPath)).rejects.toThrow(
      /account-scoped/,
    );
    await expect(
      syncSubscriptionPool({
        assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }),
        configPath,
        revision: 1,
        members: [],
        refreshRuntimeAuth: async () => {},
      }),
    ).rejects.toThrow(/different content/);
    expect(
      (
        await syncSubscriptionPool({
          assertRuntimeGuard: () =>
            Promise.resolve({ runScopedFallbacks: true }),
          configPath,
          revision: 1,
          members,
          refreshRuntimeAuth: async () => {},
        })
      ).phase,
    ).toBe("applied");
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
    const state = await fs.readFile(
      configPath + ".golem-openai-pool.json",
      "utf8",
    );
    expect(state).not.toContain("synthetic");
    expect(state).not.toContain("refresh");
  });
  it("reconciles a partial pending snapshot only through no-rewrite verification, never a new credential write", async () => {
    const { configPath } = await fixture();
    const input = { configPath, revision: 1, members, assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }) };
    await expect(syncSubscriptionPool({ ...input, refreshRuntimeAuth: () => Promise.reject(Error("refresh interrupted")) })).rejects.toThrow("refresh interrupted");
    writer.mockClear();
    const refresh = vi.fn(() => Promise.resolve());
    await expect(syncSubscriptionPool({ ...input, revision: 2, reconcileOnly: true, refreshRuntimeAuth: refresh })).rejects.toMatchObject({ code: "OPENAI_POOL_RECONCILE_CONFLICT" });
    expect(writer).not.toHaveBeenCalled();
    await syncSubscriptionPool({ ...input, reconcileOnly: true, refreshRuntimeAuth: refresh });
    expect(writer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reconcileOnly: true }));
    expect(refresh).toHaveBeenCalledOnce();
    expect((await readSubscriptionPoolState(configPath))?.phase).toBe("applied");
  });
  it("keeps a partial snapshot pending when no-rewrite store verification refuses", async () => {
    const { configPath } = await fixture();
    const input = { configPath, revision: 1, members, assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }) };
    await expect(syncSubscriptionPool({ ...input, refreshRuntimeAuth: () => Promise.reject(Error("refresh interrupted")) })).rejects.toThrow("refresh interrupted");
    writer.mockRejectedValueOnce(Error("AUTH_POOL_WRITER_STORE_READBACK_MISMATCH"));
    const refresh = vi.fn(() => Promise.resolve());
    await expect(syncSubscriptionPool({ ...input, reconcileOnly: true, refreshRuntimeAuth: refresh })).rejects.toThrow("STORE_READBACK_MISMATCH");
    expect(refresh).not.toHaveBeenCalled();
    expect((await readSubscriptionPoolState(configPath))?.phase).toBe("pending");
  });
  it("rejects missing live guard before runtime-store or receipt effects", async () => {
    const { configPath, text } = await fixture(["openai/other"]);
    await expect(
      syncSubscriptionPool({
        assertRuntimeGuard: () => Promise.reject(Error("guard missing")),
        configPath,
        revision: 1,
        members,
        refreshRuntimeAuth: async () => {},
      }),
    ).rejects.toThrow(/guard missing/);
    expect(writer).not.toHaveBeenCalled();
    expect(await readSubscriptionPoolState(configPath)).toBeNull();
    expect(await fs.readFile(configPath, "utf8")).toBe(text);
  });
  it("preserves pending intent if runtime auth-store write fails, without a false ack", async () => {
    const { configPath } = await fixture();
    writer.mockRejectedValue(new Error("SDK refused"));
    const refresh = vi.fn();
    await expect(
      syncSubscriptionPool({
        assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }),
        configPath,
        revision: 3,
        members,
        refreshRuntimeAuth: refresh,
      }),
    ).rejects.toThrow("SDK refused");
    expect(refresh).not.toHaveBeenCalled();
    expect((await readSubscriptionPoolState(configPath))?.phase).toBe(
      "pending",
    );
    await expect(
      syncSubscriptionPool({
        assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }),
        configPath,
        revision: 2,
        members,
        refreshRuntimeAuth: refresh,
      }),
    ).rejects.toThrow(/superseded/);
  });
});

it("preserves an authored fallback chain when the live guard is confirmed separately", async () => {
  const { configPath, text } = await fixture(["anthropic/paid"]);
  const assertRuntimeGuard = vi.fn(() =>
    Promise.resolve({ runScopedFallbacks: true }),
  );
  writer.mockResolvedValue(undefined);
  await syncSubscriptionPool({
    configPath,
    revision: 1,
    members,
    assertRuntimeGuard,
    refreshRuntimeAuth: async () => {},
  });
  expect(assertRuntimeGuard).toHaveBeenCalledOnce();
  expect(await fs.readFile(configPath, "utf8")).toBe(text);
  expect((await readSubscriptionPoolState(configPath))?.phase).toBe("applied");
});

it("rejects strict fallback before credential/config writes and preserves the entire authored configuration", async () => {
  const { configPath, text } = await fixture(["anthropic/paid"]);
  const wait = vi.fn();
  await expect(syncSubscriptionPool({ configPath, revision: 1, members, assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }), waitForConfigApplied: wait, refreshRuntimeAuth: async () => {} })).rejects.toMatchObject({code:"OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN"});
  expect(writer).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  expect(await fs.readFile(configPath,"utf8")).toBe(text);
  expect(await readSubscriptionPoolState(configPath)).toBeNull();
});
it("syncs a strict pool without rewriting empty fallback settings", async () => {
  const { configPath, text } = await fixture();
  writer.mockResolvedValue(undefined);
  await expect(
    syncSubscriptionPool({
      configPath,
      revision: 1,
      members,
      assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
      waitForConfigApplied: async () => {},
      refreshRuntimeAuth: async () => {},
    }),
  ).resolves.toMatchObject({ phase: "applied" });
  expect(writer).toHaveBeenCalledOnce();
  expect(await fs.readFile(configPath, "utf8")).toBe(text);
});
it("keeps cleanup pending on runtime failure, then reconciles exact replay without restoring fallbacks", async () => {
  const { configPath } = await fixture();
  const base = {
    configPath,
    revision: 3,
    members,
    assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
    refreshRuntimeAuth: vi.fn(),
  };
  await expect(
    syncSubscriptionPool({
      ...base,
      waitForConfigApplied: () =>
        Promise.reject(new Error("runtime not applied")),
    }),
  ).rejects.toThrow("runtime not applied");
  expect((await readSubscriptionPoolState(configPath))?.phase).toBe("pending");
  expect(writer).not.toHaveBeenCalled();
  expect(base.refreshRuntimeAuth).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
    agents: { defaults: { model: { fallbacks: [] } } },
  });
  await expect(
    syncSubscriptionPool({
      ...base,
      revision: 2,
      waitForConfigApplied: async () => {},
    }),
  ).rejects.toThrow(/superseded/);
  await expect(
    syncSubscriptionPool({ ...base, waitForConfigApplied: async () => {} }),
  ).resolves.toMatchObject({ phase: "applied" });
});
it("rejects a concurrent edit before credential effects without overwriting it", async () => {
  const { configPath } = await fixture();
  await expect(
    syncSubscriptionPool({
      configPath,
      revision: 1,
      members,
      assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
      waitForConfigApplied: async () => {
        await fs.writeFile(configPath, "{}");
      },
      refreshRuntimeAuth: async () => {},
    }),
  ).rejects.toThrow("CONFIG_CONFLICT");
  expect(writer).not.toHaveBeenCalled();
  expect(await fs.readFile(configPath, "utf8")).toBe("{}");
  expect((await readSubscriptionPoolState(configPath))?.phase).toBe("pending");
});
it("refuses strict sync without runtime verification before any effects", async () => {
  const { configPath, text } = await fixture();
  await expect(
    syncSubscriptionPool({
      configPath,
      revision: 1,
      members,
      assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
      refreshRuntimeAuth: async () => {},
    }),
  ).rejects.toMatchObject({ code: "OPENAI_POOL_GUARD_UPDATE_REQUIRED" });
  expect(writer).not.toHaveBeenCalled();
  expect(await readSubscriptionPoolState(configPath)).toBeNull();
  expect(await fs.readFile(configPath, "utf8")).toBe(text);
});

it("stale or invalid enrollment never clears an existing fallback chain", async () => {
  const { configPath, text } = await fixture();
  const input = {
    configPath,
    revision: 3,
    members,
    assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
    waitForConfigApplied: async () => {},
    refreshRuntimeAuth: async () => {},
  };
  await expect(
    syncSubscriptionPool({ ...input, members: [...members, ...members] }),
  ).rejects.toThrow(/Duplicate/);
  expect(await readSubscriptionPoolState(configPath)).toBeNull();
  expect(await fs.readFile(configPath, "utf8")).toBe(text);
  await syncSubscriptionPool(input);
  writer.mockClear();
  await fs.writeFile(configPath, text);
  await expect(syncSubscriptionPool({ ...input, revision: 2 })).rejects.toThrow(
    /superseded/,
  );
  expect(writer).not.toHaveBeenCalled();
  expect(await fs.readFile(configPath, "utf8")).toBe(text);
});

it.each([false, true])("connects a fresh generated route only after runtime application, preserving model fence (runScoped=%s)", async runScopedFallbacks => {
  vi.stubEnv("BACKEND_BASE_URL", "https://dev-api.golemworkers.com");
  vi.stubEnv("RELAY_TOKEN", "synthetic-managed-token");
  try {
    const { configPath } = await fixture();
    const proxy = { baseUrl: "https://dev-api.golemworkers.com/api/v1/relays/openai/v1", models: [], agentRuntime: { id: "openclaw" } };
    const before = { agents: { defaults: { model: { primary: "openai/gpt-5.6-luna", fallbacks: runScopedFallbacks ? ["anthropic/retained"] : [] }, thinkingDefault: "high", models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } } } }, models: { providers: { openai: proxy, codex: proxy } }, env: { vars: { OPENAI_API_KEY: "synthetic-managed-token", OPENAI_BASE_URL: "https://dev-api.golemworkers.com/api/v1/relays/openai/v1", KEEP: "untouched" } }, channels: { telegram: { enabled: true } } };
    await fs.writeFile(configPath, JSON.stringify(before));
    const { withModelFenceLock, writeModelFence, readModelFence } = await import("./modelFence.js");
    await withModelFenceLock(configPath, () => writeModelFence(configPath, { revision: "fresh-connect", predecessor: null, status: "APPLIED", model: before.agents.defaults.model.primary }));
    const fence = await readModelFence(configPath);
    const wait = vi.fn(async (text: string) => {
      expect(writer).not.toHaveBeenCalled();
      expect(JSON.parse(text)).toMatchObject({ agents: before.agents, channels: before.channels, models: { providers: { openai: { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex" } } } });
      expect((await readSubscriptionPoolState(configPath))?.phase).toBe("pending");
    });
    writer.mockImplementation(() => { expect(wait).toHaveBeenCalledOnce(); return Promise.resolve(); });
    await expect(syncSubscriptionPool({ configPath, revision: 1, members, assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks }), waitForConfigApplied: wait, refreshRuntimeAuth: async () => {} })).resolves.toMatchObject({ phase: "applied" });
    expect(await readModelFence(configPath)).toEqual(fence);
    expect(writer).toHaveBeenCalledOnce();
  } finally { vi.unstubAllEnvs(); }
});

it("refuses changed guard proof after runtime application before installing credentials", async () => {
  const { configPath } = await fixture();
  const assertRuntimeGuard = vi.fn().mockResolvedValueOnce({ runScopedFallbacks: false }).mockResolvedValueOnce({ runScopedFallbacks: true });
  await expect(syncSubscriptionPool({ configPath, revision: 1, members, assertRuntimeGuard, waitForConfigApplied: () => Promise.resolve(), refreshRuntimeAuth: () => Promise.resolve() })).rejects.toMatchObject({ code: "OPENAI_POOL_GUARD_UPDATE_REQUIRED" });
  expect(writer).not.toHaveBeenCalled();
  expect((await readSubscriptionPoolState(configPath))?.phase).toBe("pending");
});
