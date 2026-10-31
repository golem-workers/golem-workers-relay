import * as probeTransport from "./modelVerificationProbe.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentControlActionSchema } from "./protocol.js";
import { executeAgentControl } from "./executeAgentControl.js";
import * as auth from "./codexLogin.js";
import { policyFile } from "../managed-runtime/runtime-policy.js";
const directories: string[] = [];
beforeEach(() => {
  vi.spyOn(auth, "getCodexLoginStatus").mockResolvedValue({ state: "connected", authModes: { openaiLogin: { active: true, available: true } } } as Awaited<ReturnType<typeof auth.getCodexLoginStatus>>);
  vi.spyOn(auth, "hasPersistedChatGptSubscription").mockResolvedValue(true);
  vi.spyOn(auth, "hasPersistedOpenAiApiKey").mockResolvedValue(false);
  vi.spyOn(auth, "hasChatGptRouteOverrides").mockResolvedValue(false);
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY"]) vi.stubEnv(key, undefined);
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture(harness: "openclaw" | "codex" = "openclaw") {
  const proof = vi.spyOn(probeTransport, "runIsolatedModelProbe").mockImplementation(request => Promise.resolve({ status: "ok", result: { payloads: [{ text: request.messageText.includes("GW_MODEL_VERIFY_GRANT:") ? "OK" : request.messageText.split(" ")[2].slice(0, -1) }], meta: { agentMeta: { provider: "openai", model: "gpt-6-astra", agentHarnessId: harness } } } }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-verify-runtime-")); directories.push(dir);
  const configPath = path.join(dir, "config.json");
  const config = { agents: { defaults: { model: { primary: "openai/gpt-6-astra", fallbacks: [] as string[] }, models: { "openai/gpt-6-astra": { agentRuntime: { id: harness } } } } } };
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(policyFile(configPath), JSON.stringify({ schemaVersion: 1, revision: 1, chatHarness: harness }));
  // Captured 2026.9.7 contract: selected runtime is metadata; fresh entry has no producer identity.
  const before = { resolved: { modelProvider: "openai", model: "gpt-6-astra", agentRuntime: { id: harness, source: "model" } as unknown, runtimeSelectionLocked: false }, entry: {} };
  const after = { resolved: { ...before.resolved }, entry: { modelProvider: "openai", model: "gpt-6-astra", agentHarnessId: harness as string | undefined } };
  let patches = 0;
  const gateway = { request: vi.fn((method: string, params?: unknown) => {
    expect(params).not.toHaveProperty("model");
    if (method === "sessions.patch") return Promise.resolve(++patches === 1 ? before : after);
    if (method === "chat.abort" || method === "sessions.delete") return Promise.resolve({});
    throw new Error("Unexpected RPC: " + method);
  }) };
  const statusNudgeRunner = { runChatTask: vi.fn(() => Promise.resolve({ result: { outcome: "reply" as const, reply: { runId: "fixture", message: "OK" } }, openclawMeta: {} })) };
  const run = (verificationGrant?: string) => executeAgentControl({ configPath, gateway, statusNudgeRunner, action: agentControlActionSchema.parse({ kind: "model.verify", model: "codex/gpt-6-astra", ...(verificationGrant ? { verificationGrant } : {}) }) });
  return { configPath, config, before, after, gateway, statusNudgeRunner, proof, run };
}
it("carries the backend verification grant only in the disposable probe without persisting config", async () => {
  const f = await fixture();
  const before = await fs.readFile(f.configPath, "utf8");
  await expect(f.run("signed-payload.signature")).resolves.toMatchObject({ verified: true });
  expect(f.proof).toHaveBeenCalledWith(expect.objectContaining({ messageText: "Reply with OK only. This is a model connectivity check. Do not use tools.\nGW_MODEL_VERIFY_GRANT:signed-payload.signature" }));
  expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  expect(f.gateway.request.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "sessions.patch", "sessions.delete"]);
  expect(() => agentControlActionSchema.parse({ kind: "model.verify", model: "codex/gpt-6-astra", verificationGrant: "invalid!" })).toThrow();
});
it.each(["openclaw", "codex"] as const)("verifies actual metadata-object contract with %s policy and empty pre-inference entry", async harness => {
  const f = await fixture(harness);
  const configBefore = await fs.readFile(f.configPath, "utf8");
  await expect(f.run()).resolves.toMatchObject({ kind: "model.verify", verified: true });
  expect(f.proof).toHaveBeenCalledOnce();
  expect(f.gateway.request.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "sessions.patch", "sessions.delete"]);
  expect(await fs.readFile(f.configPath, "utf8")).toBe(configBefore);
});
it.each([
  ["absent", undefined], ["null", null], ["undocumented string", "openclaw"],
  ["empty object", {}], ["numeric id", { id: 1 }], ["empty id", { id: "" }],
  ["unknown id", { id: "unknown" }], ["array", [{ id: "openclaw" }]],
  ["different harness", { id: "codex", source: "model" }],
])("rejects %s selected runtime before inference and cleans up", async (_label, runtime) => {
  const f = await fixture(); f.before.resolved.agentRuntime = runtime;
  await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH", message: "Runtime default model differs from selected model" });
  expect(f.proof).not.toHaveBeenCalled();
  expect(f.gateway.request.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "chat.abort", "sessions.delete"]);
});
it.each(["missing-runtime", "wrong-runtime", "wrong-model", "wrong-provider", "missing-producer", "wrong-producer"])("rejects post-inference %s without confusing selection with producer identity", async kind => {
  const f = await fixture();
  if (kind === "missing-runtime") f.after.resolved.agentRuntime = undefined;
  if (kind === "wrong-runtime") f.after.resolved.agentRuntime = { id: "codex", source: "model" };
  if (kind === "wrong-model") f.after.entry.model = "other";
  if (kind === "wrong-provider") f.after.entry.modelProvider = "anthropic";
  if (kind === "missing-producer") f.after.entry.agentHarnessId = undefined;
  if (kind === "wrong-producer") f.after.entry.agentHarnessId = "codex";
  await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH", message: "Inference used another provider/model or runtime" });
  expect(f.proof).toHaveBeenCalledOnce();
  expect(f.gateway.request.mock.calls.map(([method]) => method)).toEqual(["sessions.patch", "sessions.patch", "chat.abort", "sessions.delete"]);
});
it.each(["wrong-model", "wrong-provider"])("rejects selected %s before inference", async kind => {
  const f = await fixture();
  if (kind === "wrong-model") f.before.resolved.model = "other";
  else f.before.resolved.modelProvider = "anthropic";
  await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
  expect(f.proof).not.toHaveBeenCalled();
});
it("preserves zero-fallback guard before probing runtime", async () => {
  const f = await fixture(); f.config.agents.defaults.model.fallbacks = ["anthropic/other"];
  await fs.writeFile(f.configPath, JSON.stringify(f.config));
  await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH", message: "Selected config or zero-fallback policy differs" });
  expect(f.gateway.request).not.toHaveBeenCalled();
});
it("does not substitute selected runtime for required subscription proof", async () => {
  const f = await fixture(); vi.mocked(auth.hasPersistedChatGptSubscription).mockResolvedValue(false);
  await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
  expect(f.proof).not.toHaveBeenCalled();
});
it.each([false, true])("retries only disposable-session cleanup CAS, preserving mismatch=%s", async mismatch => {
  const f = await fixture("codex");
  if (mismatch) f.after.entry.model = "gpt-6-other";
  const request = f.gateway.request.getMockImplementation();
  if (!request) throw new Error("fixture request missing");
  let deletions = 0;
  const keys: string[] = [];
  f.gateway.request.mockImplementation((method: string, params?: unknown) => {
    if (method === "sessions.delete") {
      const key = (params as { key: string }).key; keys.push(key);
      if (++deletions === 1) return Promise.reject(new Error(`INVALID_REQUEST: Session ${key} changed before deletion. Retry.`));
    }
    return request(method, params);
  });
  if (mismatch) await expect(f.run()).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
  else await expect(f.run()).resolves.toMatchObject({ verified: true });
  expect(deletions).toBe(2); expect(new Set(keys).size).toBe(1);
  expect(f.proof).toHaveBeenCalledOnce();
});
it.each(["exhausted", "foreign-key", "unrelated"]) ("does not hide %s cleanup failure", async mode => {
  const f = await fixture("codex");
  const request = f.gateway.request.getMockImplementation();
  if (!request) throw new Error("fixture request missing");
  let deletions = 0;
  f.gateway.request.mockImplementation((method: string, params?: unknown) => {
    if (method === "sessions.delete") {
      deletions += 1;
      const key = mode === "foreign-key" ? "other-session" : (params as { key: string }).key;
      return Promise.reject(new Error(mode === "unrelated" ? "permission denied" : `INVALID_REQUEST: Session ${key} changed before deletion. Retry.`));
    }
    return request(method, params);
  });
  await expect(f.run()).rejects.toThrow(mode === "unrelated" ? "permission denied" : "changed before deletion");
  expect(deletions).toBe(mode === "exhausted" ? 3 : 1);
  expect(f.proof).toHaveBeenCalledOnce();
});
