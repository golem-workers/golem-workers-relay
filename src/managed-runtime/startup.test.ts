import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { convergeManagedRuntimeAtStartup } from "./startup.js";
import { managedRuntime, normalizeManagedConfigText, policyFile, runtimeContext } from "./runtime-policy.js";

let dir: string;
let configPath: string;
const logger = { error: vi.fn() };
const restart = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks(); restart.mockReset();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-startup-"));
  configPath = path.join(dir, "openclaw.json");
  vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("CODEX_API_KEY", undefined); vi.stubEnv("OPENAI_BASE_URL", undefined);
  vi.stubEnv("CODEX_HOME", path.join(dir, "codex"));
  await fs.writeFile(policyFile(configPath), JSON.stringify({ schemaVersion: 1, revision: 2, chatHarness: "codex" }));
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });
function config(api = "openai-chatgpt-responses") {
  return { agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] }, models: { "openai/gpt-5.5": {} } } }, models: { providers: { openai: { api, baseUrl: api === "openai-responses" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api/codex" } } }, commands: { ownerAllowFrom: ["telegram:123"] } };
}
it.each(["openai-chatgpt-responses", "openai-responses"])("starts with missing %s auth without relaxing subsequent operations", async api => {
  const original = config(api);
  await fs.writeFile(configPath, JSON.stringify(original));
  expect(await convergeManagedRuntimeAtStartup(configPath, logger, restart)).toBe("restarted");
  expect(restart).toHaveBeenCalledTimes(1);
  const text = await fs.readFile(configPath, "utf8");
  const normalized = JSON.parse(text) as ReturnType<typeof config>;
  expect(managedRuntime.protectedRoute(normalized)).toEqual(managedRuntime.protectedRoute(original));
  expect(normalized.agents.defaults.models["openai/gpt-5.5"]).toMatchObject({ agentRuntime: { id: "codex" } });
  expect(managedRuntime.codexCompatibility(normalized, "openai/gpt-5.5", await runtimeContext(configPath)).supported).toBe(false);
  await expect(normalizeManagedConfigText(configPath, text)).rejects.toThrow("MANAGED_CODEX_INCOMPATIBLE");
  expect(await convergeManagedRuntimeAtStartup(configPath, logger, restart)).toBe("unchanged");
  expect(restart).toHaveBeenCalledTimes(1);
  expect(logger.error).not.toHaveBeenCalled();
});
it.each(["route", "policy", "config"])("keeps control plane alive after invalid %s without writes or restart", async invalid => {
  const c = config();
  if (invalid === "route") c.models.providers.openai.baseUrl = "https://proxy.example/v1";
  await fs.writeFile(configPath, invalid === "config" ? "invalid json" : JSON.stringify(c));
  if (invalid === "policy") await fs.writeFile(policyFile(configPath), JSON.stringify({ schemaVersion: 999 }));
  const before = await Promise.all([configPath, policyFile(configPath)].map(file => fs.readFile(file, "utf8")));
  expect(await convergeManagedRuntimeAtStartup(configPath, logger, restart)).toBe("deferred");
  expect(await Promise.all([configPath, policyFile(configPath)].map(file => fs.readFile(file, "utf8")))).toEqual(before);
  expect(restart).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ phase: "normalize" }), expect.any(String));
});
it("does not terminate relay or loop restarts after a Gateway restart failure", async () => {
  await fs.writeFile(configPath, JSON.stringify(config()));
  restart.mockRejectedValue(new Error("systemctl failed"));
  expect(await convergeManagedRuntimeAtStartup(configPath, logger, restart)).toBe("deferred");
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ phase: "restart" }), expect.any(String));
  expect(await convergeManagedRuntimeAtStartup(configPath, logger, restart)).toBe("unchanged");
  expect(restart).toHaveBeenCalledTimes(1);
});
