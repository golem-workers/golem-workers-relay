import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAgentControl } from "./executeAgentControl.js";
import * as auth from "./codexLogin.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
  { name: "2026.9.8 descriptor", runtime: { id: "openclaw", source: "model" }, valid: true },
  { name: "legacy string", runtime: "openclaw", valid: true },
  { name: "wrong descriptor runtime", runtime: { id: "codex", source: "model" }, valid: false },
  { name: "missing descriptor id", runtime: { source: "model" }, valid: false },
  { name: "nonstring id", runtime: { id: 1 }, valid: false },
  { name: "array", runtime: ["openclaw"], valid: false },
  { name: "absent runtime", runtime: undefined, valid: false },
])("verifies actual Gateway identity without relaxing fences: $name", async ({ runtime, valid }) => {
  await probe({ beforeRuntime: runtime, afterRuntime: runtime, valid, shouldInfer: valid });
});

it.each([
  { name: "runtime drift", afterRuntime: { id: "codex", source: "model" } },
  { name: "model fallback", afterModel: "other" },
  { name: "usage harness drift", afterHarness: "codex" },
])("rejects $name after inference with structured runtime metadata", async options => {
  await probe({ beforeRuntime: { id: "openclaw", source: "model" }, afterRuntime: { id: "openclaw", source: "model" }, ...options, valid: false, shouldInfer: true });
});

async function probe(input: { beforeRuntime: unknown; afterRuntime: unknown; afterModel?: string; afterHarness?: string; valid: boolean; shouldInfer: boolean }) {
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "RELAY_SERVER_ID"]) vi.stubEnv(key, undefined);
  vi.spyOn(auth, "getCodexLoginStatus").mockResolvedValue({ state: "connected", authModes: { openaiLogin: { active: true, available: true } } } as Awaited<ReturnType<typeof auth.getCodexLoginStatus>>);
  vi.spyOn(auth, "hasPersistedChatGptSubscription").mockResolvedValue(true);
  vi.spyOn(auth, "hasPersistedOpenAiApiKey").mockResolvedValue(false);
  vi.spyOn(auth, "hasChatGptRouteOverrides").mockResolvedValue(false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "issue665-runtime-"));
  try {
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { model: { primary: "openai/example", fallbacks: [] }, models: { "openai/example": { agentRuntime: { id: "openclaw" } } } } } }));
    let patches = 0;
    const calls: string[] = [];
    const gateway = { request: (method: string, params?: unknown) => {
      calls.push(method);
      expect(params).not.toHaveProperty("model");
      if (method !== "sessions.patch") return Promise.resolve({});
      patches++;
      return Promise.resolve({ resolved: { modelProvider: "openai", model: "example", agentRuntime: patches === 1 ? input.beforeRuntime : input.afterRuntime }, entry: patches === 1 ? {} : { modelProvider: "openai", model: input.afterModel ?? "example", agentHarnessId: input.afterHarness ?? "openclaw" } });
    } };
    const runChatTask = vi.fn(() => Promise.resolve({ result: { outcome: "reply" as const, reply: { runId: "synthetic", message: "OK" } }, openclawMeta: {} }));
    const result = executeAgentControl({ configPath, gateway, action: { kind: "model.verify", model: "codex/example" }, statusNudgeRunner: { runChatTask } });
    if (input.valid) await expect(result).resolves.toMatchObject({ kind: "model.verify", verified: true });
    else await expect(result).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
    expect(runChatTask).toHaveBeenCalledTimes(input.shouldInfer ? 1 : 0);
    expect(calls.at(-1)).toBe("sessions.delete");
    expect(calls.includes("chat.abort")).toBe(!input.valid);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
