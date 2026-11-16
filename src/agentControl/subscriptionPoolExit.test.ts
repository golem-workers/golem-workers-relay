import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const writer = vi.hoisted(() => vi.fn());
vi.mock("./runtimeAuthWriter.js", () => ({ writeRuntimeAuthPool: writer }));
import { exitSubscriptionPool, prepareSubscriptionPoolExitConfig, assertSubscriptionPoolApiRoute } from "./subscriptionPoolExit.js";
import { syncSubscriptionPool, readSubscriptionPoolState, assertLegacyAuthMutationAllowed } from "./subscriptionPoolManager.js";
import { prepareSubscriptionPoolConfig } from "./subscriptionPoolConfig.js";
import { assertSubscriptionOnlyConfiguration } from "./openAiSubscriptionPool.js";
const env = { BACKEND_BASE_URL: "https://backend.test", RELAY_TOKEN: "fixture-token" };
const config = () => ({ agents: { defaults: { model: { primary: "openai/gpt-5.6-luna", fallbacks: [] }, thinkingDefault: "high" } }, models: { providers: { openai: { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex", models: [], agentRuntime: { id: "openclaw" } }, other: { models: [] } } }, tools: { deny: ["exec"] }, env: { vars: { KEEP: "same" } } });
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); writer.mockReset(); await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function fixture() {
 vi.stubEnv("BACKEND_BASE_URL", env.BACKEND_BASE_URL); vi.stubEnv("RELAY_TOKEN", env.RELAY_TOKEN);
 const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-exit-")); roots.push(root); const configPath = path.join(root, "openclaw.json"); await fs.writeFile(configPath, JSON.stringify(config()));
 await syncSubscriptionPool({ configPath, revision: 1, members: [], assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }), refreshRuntimeAuth: () => Promise.resolve() }); writer.mockClear();
 return configPath;
}
it("restores only managed API routing, preserving model and unrelated config; permits later explicit reconnect", () => {
 const before = config(), api = prepareSubscriptionPoolExitConfig(before, env);
 expect(before).toEqual(config()); expect(api.agents).toEqual(before.agents); expect(api.tools).toEqual(before.tools);
 expect(api.env).toEqual({ vars: { KEEP: "same", OPENAI_API_KEY: env.RELAY_TOKEN, OPENAI_BASE_URL: env.BACKEND_BASE_URL + "/api/v1/relays/openai/v1" } });
 expect(prepareSubscriptionPoolExitConfig(api, env)).toEqual(api);
 const again = prepareSubscriptionPoolConfig(api, { runScopedFallbacks: false }, env); expect(() => assertSubscriptionOnlyConfiguration(again, env)).not.toThrow(); expect(again.agents).toEqual(before.agents);
});
it.each([{ headers: { custom: "keep" } }, { apiKey: "user-key" }, { baseUrl: "https://user.test" }, { agentRuntime: { id: "custom" } }, { models: [{ id: "custom" }] }])("refuses authored provider before effects %j", patch => {
 const cfg = config(); Object.assign(cfg.models.providers.openai, patch); expect(() => prepareSubscriptionPoolExitConfig(cfg, env)).toThrow(/authored/); expect(cfg.models.providers.openai).toMatchObject(patch);
});
it("keeps exiting receipt on auth failure; exact replay applies, stale sync/exit cannot resurrect pool", async () => {
 const configPath = await fixture(); const text = await fs.readFile(configPath, "utf8");
 writer.mockRejectedValueOnce(Error("store failed")); const refresh = vi.fn(), wait = vi.fn();
 await expect(exitSubscriptionPool({ configPath, revision: 2, refreshRuntimeAuth: refresh, waitForConfigApplied: wait })).rejects.toThrow("store failed");
 expect((await readSubscriptionPoolState(configPath))?.phase).toBe("exiting"); expect(await fs.readFile(configPath, "utf8")).toBe(text); expect(refresh).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
 await expect(assertLegacyAuthMutationAllowed(configPath)).rejects.toThrow(/account-scoped/);
 await expect(exitSubscriptionPool({ configPath, revision: 3, refreshRuntimeAuth: refresh, waitForConfigApplied: wait })).rejects.toThrow(/Reconcile/);
 const result = await exitSubscriptionPool({ configPath, revision: 2, refreshRuntimeAuth: refresh, waitForConfigApplied: wait }); expect(result.phase).toBe("exited"); expect(result.members).toEqual([]); expect(wait).toHaveBeenCalledOnce();
 await expect(assertLegacyAuthMutationAllowed(configPath)).resolves.toBeUndefined();
 await expect(syncSubscriptionPool({ configPath, revision: 2, members: [], assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }), refreshRuntimeAuth: refresh })).rejects.toThrow(/predates/);
 const calls = writer.mock.calls.length; await exitSubscriptionPool({ configPath, revision: 2, refreshRuntimeAuth: refresh, waitForConfigApplied: wait }); expect(writer.mock.calls.length).toBe(calls);
 await syncSubscriptionPool({ configPath, revision: 3, members: [], assertRuntimeGuard: () => Promise.resolve({ runScopedFallbacks: true }), refreshRuntimeAuth: refresh, waitForConfigApplied: wait }); expect((await readSubscriptionPoolState(configPath))?.phase).toBe("applied");
});
it("does not acknowledge API source until Gateway confirms applied routing", async () => {
 const configPath = await fixture();
 await expect(exitSubscriptionPool({ configPath, revision: 2, refreshRuntimeAuth: () => Promise.resolve(), waitForConfigApplied: () => Promise.reject(Error("not applied")) })).rejects.toThrow("not applied");
 expect((await readSubscriptionPoolState(configPath))?.phase).toBe("exiting");
});
it("round-trips the exact generated Sol catalog without replacing model metadata", async () => {
 const { ensureNativePiModelCompatibility } = await import("./nativePiModelCompatibility.js");
 const cfg: Record<string, unknown> = { agents: { defaults: { model: { primary: "openai/gpt-6.1-sol", fallbacks: [] }, models: { "openai/gpt-6.1-sol": {} } } } };
 ensureNativePiModelCompatibility(cfg, true, {});
 const api = prepareSubscriptionPoolExitConfig(cfg, env); expect(api.agents).toEqual(cfg.agents);
 const restored = prepareSubscriptionPoolConfig(api, { runScopedFallbacks: false }, env); expect(() => assertSubscriptionOnlyConfiguration(restored, env)).not.toThrow(); expect(restored.agents).toEqual(cfg.agents);
});

it("accepts a redacted Gateway key only when the effective public API route is correct", () => {
 const api = prepareSubscriptionPoolExitConfig(config(), env);
 const vars = (api.env as {vars: Record<string, unknown>}).vars; vars.OPENAI_API_KEY = "__OPENCLAW_REDACTED__";
 expect(() => assertSubscriptionPoolApiRoute(api, env)).not.toThrow();
 const provider = (api.models as {providers: {openai: Record<string, unknown>}}).providers.openai;
 provider.api = "openai-chatgpt-responses"; expect(() => assertSubscriptionPoolApiRoute(api, env)).toThrow(/not applied/);
});
it("refuses conflicting per-model routing before changing credentials", () => {
 const cfg: Record<string, unknown> = config();
 (cfg.agents as {defaults: Record<string, unknown>}).defaults.models = {"openai/gpt-5.6-luna": {api:"openai-chatgpt-responses"}};
 expect(() => prepareSubscriptionPoolExitConfig(cfg, env)).toThrow(/Authored model routing/);
});
