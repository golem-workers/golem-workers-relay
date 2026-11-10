import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const writer = vi.hoisted(() => vi.fn());
vi.mock("./runtimeAuthWriter.js", () => ({ writeRuntimeAuthPool: writer }));
vi.mock("./ownerFence.js", () => ({
  withOwnerFenceLock: (_path: string, fn: () => Promise<unknown>) => fn(),
}));
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
        assertRuntimeGuard: () => Promise.resolve({runScopedFallbacks:true}),
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
        assertRuntimeGuard: () => Promise.resolve({runScopedFallbacks:true}),
        configPath,
        revision: 1,
        members: [],
        refreshRuntimeAuth: async () => {},
      }),
    ).rejects.toThrow(/different content/);
    expect(
      (
        await syncSubscriptionPool({
          assertRuntimeGuard: () => Promise.resolve({runScopedFallbacks:true}),
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
        assertRuntimeGuard: () => Promise.resolve({runScopedFallbacks:true}),
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
        assertRuntimeGuard: () => Promise.resolve({runScopedFallbacks:true}),
        configPath,
        revision: 2,
        members,
        refreshRuntimeAuth: refresh,
      }),
    ).rejects.toThrow(/superseded/);
  });
});

it("preserves an authored fallback chain when the live guard is confirmed separately",async()=>{
 const {configPath,text}=await fixture(["anthropic/paid"]);
 const assertRuntimeGuard=vi.fn(()=>Promise.resolve({runScopedFallbacks:true}));
 writer.mockResolvedValue(undefined);
 await syncSubscriptionPool({configPath,revision:1,members,assertRuntimeGuard,refreshRuntimeAuth:async()=>{}});
 expect(assertRuntimeGuard).toHaveBeenCalledOnce();
 expect(await fs.readFile(configPath,"utf8")).toBe(text);
 expect((await readSubscriptionPoolState(configPath))?.phase).toBe("applied");
});


it("refuses the 9.8 fallback policy before pending receipt or credential effects", async () => {
 const {configPath,text}=await fixture(["anthropic/paid"]);
 await expect(syncSubscriptionPool({configPath,revision:1,members,assertRuntimeGuard:()=>Promise.resolve({runScopedFallbacks:false}),refreshRuntimeAuth:async()=>{}})).rejects.toMatchObject({code:"OPENAI_POOL_MODEL_FALLBACK_FORBIDDEN"});
 expect(writer).not.toHaveBeenCalled();expect(await readSubscriptionPoolState(configPath)).toBeNull();expect(await fs.readFile(configPath,"utf8")).toBe(text);
});
it("syncs a 9.8 pool without rewriting empty fallback settings", async () => {
 const {configPath,text}=await fixture();writer.mockResolvedValue(undefined);
 await expect(syncSubscriptionPool({configPath,revision:1,members,assertRuntimeGuard:()=>Promise.resolve({runScopedFallbacks:false}),refreshRuntimeAuth:async()=>{}})).resolves.toMatchObject({phase:"applied"});
 expect(writer).toHaveBeenCalledOnce();expect(await fs.readFile(configPath,"utf8")).toBe(text);
});
