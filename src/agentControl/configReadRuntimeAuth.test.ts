import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { executeAgentControl } from "./executeAgentControl.js";
import { agentControlActionSchema, agentControlResultSchema } from "./protocol.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "config-auth-proof-")); dirs.push(root);
  const configPath = path.join(root, "openclaw.json"); await fs.writeFile(configPath, "{}\n");
  return { root, configPath, gateway: { request: () => Promise.resolve({}) } };
}
it.each([
  { type: "oauth", provider: "openai-codex", expires: 1, access: "fixture-secret", subscriptionAuth: true, apiKeyAuth: false },
  { type: "api_key", provider: "openai", key: "fixture-secret", subscriptionAuth: false, apiKeyAuth: true },
  { type: "oauth", provider: "openai", authFlow: "chatgpt-identity", access: "fixture-secret", subscriptionAuth: false, apiKeyAuth: false },
])("opt-in proof uses persisted route identity, not login readiness: $type/$authFlow", async sample => {
  const input = await fixture();
  const { subscriptionAuth, apiKeyAuth, ...credential } = sample;
  await fs.writeFile(path.join(input.root, "auth-profiles.json"), JSON.stringify({ profiles: { selected: credential } }));
  const result = await executeAgentControl({ ...input, action: { kind: "config.read", includeRuntimeAuthContext: true } });
  expect(result).toHaveProperty("runtimeAuthContext", { version: 1, subscriptionAuth, apiKeyAuth });
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(agentControlResultSchema.parse(result)).toEqual(result);
  expect(await fs.readFile(input.configPath, "utf8")).toBe("{}\n");
});
it("shared SQLite ownership excludes stale legacy API-key profiles", async () => {
  const input = await fixture(); await fs.mkdir(path.join(input.root, "state"));
  const db = new DatabaseSync(path.join(input.root, "state/openclaw.sqlite"));
  db.exec("CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)");
  const insert = db.prepare("INSERT INTO config_machine_state VALUES (?,?)");
  insert.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
  insert.run("authProfiles.store", JSON.stringify({ profiles: { subscribed: { type: "oauth", provider: "openai", access: "fixture-secret", expires: 1 } } })); db.close();
  await fs.writeFile(path.join(input.root, "auth-profiles.json"), JSON.stringify({ profiles: { stale: { type: "api_key", provider: "openai", key: "stale-secret" } } }));
  const result = await executeAgentControl({ ...input, action: { kind: "config.read", includeRuntimeAuthContext: true } });
  expect(result).toHaveProperty("runtimeAuthContext", { version: 1, subscriptionAuth: true, apiKeyAuth: false });
  expect(JSON.stringify(result)).not.toMatch(/fixture-secret|stale-secret/);
});
it("ordinary config.read skips the additional strict offline-reader probe", async () => {
  const input = await fixture(); await fs.writeFile(path.join(input.root, "auth-profiles.json"), "malformed");
  const result = await executeAgentControl({ ...input, action: { kind: "config.read" } });
  expect(result).not.toHaveProperty("runtimeAuthContext");
  await expect(executeAgentControl({ ...input, action: { kind: "config.read", includeRuntimeAuthContext: true } })).rejects.toThrow();
});
it("protocol preserves the optional request flag and rejects nonboolean proof", () => {
  expect(agentControlActionSchema.parse({ kind: "config.read", includeRuntimeAuthContext: true })).toMatchObject({ includeRuntimeAuthContext: true });
  expect(agentControlResultSchema.safeParse({ kind: "config.read", config: {}, configText: "{}", runtimeAuthContext: { version: 1, subscriptionAuth: "guess", apiKeyAuth: false } }).success).toBe(false);
});
