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

it("clears strict fallback before credentials and keeps other config/model fence unchanged", async () => {
  const { configPath } = await fixture(["anthropic/paid"]);
  const { withModelFenceLock, writeModelFence, readModelFence } =
    await import("./modelFence.js");
  const { withAuthorizationConfig } =
    await import("../managed-runtime/runtime-policy.js");
  const { writeOwnerFencedConfig } = await import("./ownerFence.js");
  const cfg = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    agents: {
      defaults: Record<string, unknown> & {
        model: { primary: string; fallbacks: string[] };
      };
    };
    [key: string]: unknown;
  };
  cfg.agents.defaults.thinkingDefault = "high";
  cfg.agents.defaults.models = {
    "openai/gpt-6.1-sol": {
      agentRuntime: { id: "codex" },
      params: { fastMode: true },
    },
  };
  cfg.agents.defaults.memorySearch = { fallback: "none" };
  cfg.plugins = { entries: { codex: { config: { fallback: "openclaw" } } } };
  cfg.channels = { telegram: { enabled: true } };
  cfg.env = { KEEP: "synthetic" };
  await withAuthorizationConfig(configPath, () =>
    writeOwnerFencedConfig(configPath, JSON.stringify(cfg)),
  );
  await withModelFenceLock(configPath, () =>
    writeModelFence(configPath, {
      revision: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      predecessor: null,
      status: "APPLIED",
      model: "openai/gpt-6.1-sol",
    }),
  );
  const fence = await readModelFence(configPath);
  const wait = vi.fn(async (text: string) => {
    expect(JSON.parse(text)).toEqual({
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents.defaults,
          model: { ...cfg.agents.defaults.model, fallbacks: [] },
        },
      },
    });
    expect((await readSubscriptionPoolState(configPath))?.phase).toBe(
      "pending",
    );
    expect(writer).not.toHaveBeenCalled();
  });
  await expect(
    syncSubscriptionPool({
      configPath,
      revision: 1,
      members,
      assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: false }),
      waitForConfigApplied: wait,
      refreshRuntimeAuth: async () => {},
    }),
  ).resolves.toMatchObject({ phase: "applied" });
  expect(wait).toHaveBeenCalledOnce();
  expect(writer).toHaveBeenCalledOnce();
  expect(await readModelFence(configPath)).toEqual(fence);
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
  const { configPath } = await fixture(["anthropic/paid"]);
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
  const { configPath } = await fixture(["paid/model"]);
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
  const { configPath, text } = await fixture(["paid/model"]);
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
  const { configPath, text } = await fixture(["paid/model"]);
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
