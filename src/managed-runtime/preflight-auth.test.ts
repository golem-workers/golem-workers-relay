import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeAgentControl } from "../agentControl/executeAgentControl.js";
import { managedRuntime, policyFile } from "./runtime-policy.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "./policy.generated.js";

let dir: string;
let configPath: string;
let cliPath: string;
let authPath: string;
let databasePath: string;
const oauth = { type: "oauth", provider: "openai", access: "synthetic-access", refresh: "synthetic-refresh", expires: 4700000000000 };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "preflight-auth-"));
  configPath = path.join(dir, "openclaw.json"); cliPath = path.join(dir, "codex", "auth.json");
  authPath = path.join(dir, "auth-profiles.json"); databasePath = path.join(dir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(cliPath));
  vi.stubEnv("CODEX_HOME", path.dirname(cliPath));
  vi.stubEnv("OPENAI_API_KEY", undefined); vi.stubEnv("CODEX_API_KEY", undefined); vi.stubEnv("OPENAI_BASE_URL", undefined);
  await fs.writeFile(cliPath, JSON.stringify({ auth_mode: "chatgpt" }));
  await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: { "openai:oauth": oauth } }));
  await fs.writeFile(policyFile(configPath), JSON.stringify(managedRuntime.defaultPolicy));
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(dir, { recursive: true, force: true }); });
function config() {
  return { agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] as string[] } } }, models: { providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" } as Record<string, unknown> } }, env: {} as Record<string, unknown> };
}
async function check(candidate: ReturnType<typeof config>, accepted: boolean, mode: "api_key" | "openai_login" = "api_key") {
  await fs.writeFile(configPath, JSON.stringify(candidate));
  const files = [configPath, cliPath, authPath, policyFile(configPath), databasePath];
  const snapshot = () => Promise.all(files.map(file => fs.readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; })));
  const before = await snapshot();
  const run = executeAgentControl({ configPath, policyAuthority: "backend", gateway: { request: () => Promise.resolve({}) }, action: {
    kind: "managedRuntime.preflight", codexAuthMode: mode,
    managedRuntimePolicy: managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId: "agent-a", revision: 1, harnessOverride: "codex" }),
    managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256,
  } });
  if (accepted) await expect(run).resolves.toMatchObject({ kind: "managedRuntime.preflight", compatible: true });
  else await expect(run).rejects.toMatchObject({ code: "MANAGED_CODEX_INCOMPATIBLE" });
  expect(await snapshot()).toEqual(before);
}
it.each(["provider", "config-env", "config-env-vars", "process", "cli", "runtime"])("proves an available %s key alongside inactive OAuth without mutation", async source => {
  const c = config();
  if (source === "provider") c.models.providers.openai.apiKey = "synthetic-key";
  if (source === "config-env") c.env.OPENAI_API_KEY = "synthetic-key";
  if (source === "config-env-vars") c.env.vars = { OPENAI_API_KEY: "synthetic-key" };
  if (source === "process") vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
  if (source === "cli") await fs.writeFile(cliPath, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "synthetic-key" }));
  if (source === "runtime") await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: { "openai:oauth": oauth, "openai:key": { type: "api_key", provider: "openai", key: "synthetic-key" } } }));
  await check(c, true);
});
it.each([undefined, "", "   ", false])("rejects CLI mode-only/invalid key %s and runtime API markers", async key => {
  await fs.writeFile(cliPath, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: key }));
  await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: { "openai:oauth": oauth, "openai:key": { type: "api_key", provider: "openai" } } }));
  await check(config(), false);
});
it.each(["proxy", "oauth-route", "fallback", "headers", "wrong-provider-key"])("does not let CLI API intent rewrite or bypass %s", async route => {
  const c = config();
  if (route !== "wrong-provider-key") await fs.writeFile(cliPath, JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "synthetic-key" }));
  if (route === "proxy") c.models.providers.openai.baseUrl = "https://proxy.example/v1";
  if (route === "oauth-route") Object.assign(c.models.providers.openai, { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex" });
  if (route === "fallback") c.agents.defaults.model.fallbacks = ["anthropic/claude"];
  if (route === "headers") c.models.providers.openai.headers = { "x-custom": "value" };
  if (route === "wrong-provider-key") Object.assign(c.models.providers, { anthropic: { apiKey: "synthetic-other-key" } });
  await check(c, false);
});
it.each([false, true])("respects shared-machine OAuth ownership (present=%s) despite CLI tokens/legacy auth", async present => {
  await fs.mkdir(path.dirname(databasePath));
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER)");
  const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, 0)");
  insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  insert.run("authProfiles.store", JSON.stringify({ version: 1, profiles: present ? { "openai:oauth": oauth } : {} }));
  db.close();
  await fs.writeFile(cliPath, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic", refresh_token: "synthetic", id_token: "synthetic" } }));
  const c = config(); Object.assign(c.models.providers.openai, { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.com/backend-api/codex" });
  await check(c, present, "openai_login");
});
it("does not promote stale legacy API keys when machine-owned auth is empty", async () => {
  await fs.mkdir(path.dirname(databasePath)); const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)");
  db.prepare("INSERT INTO config_machine_state VALUES (?, ?)").run("auth.sharedStore", JSON.stringify({ location: "state-db" })); db.close();
  await fs.writeFile(authPath, JSON.stringify({ version: 1, profiles: { "openai:key": { type: "api_key", provider: "openai", key: "stale-key" } } }));
  await check(config(), false);
});
