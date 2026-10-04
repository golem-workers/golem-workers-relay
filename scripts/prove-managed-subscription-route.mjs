// Offline installed-runtime proof. Build first; no live auth, network or service writes.
// Private runtime exports are discovered by source name ONLY in this diagnostic;
// production relay code never imports private OpenClaw modules.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { resolveRuntimeAuthSdk, writeRuntimeAuth } from "../dist/agentControl/runtimeAuthWriter.js";
import { executeAgentControl } from "../dist/agentControl/executeAgentControl.js";
const sdk = await resolveRuntimeAuthSdk();
const dist = path.dirname(path.dirname(sdk));
const runtimeVersion = JSON.parse(await fs.readFile(path.join(dist, "../package.json"), "utf8")).version;
async function runtimeFunction(prefix, name) {
  const candidates = [];
  for (const file of await fs.readdir(dist)) {
    if (!file.startsWith(prefix) || !file.endsWith(".mjs")) continue;
    const text = await fs.readFile(path.join(dist, file), "utf8");
    if (text.includes("function " + name + "(")) candidates.push({ file, text });
  }
  assert.equal(candidates.length, 1, "Unambiguous installed function " + name);
  const { file, text } = candidates[0];
  const entry = text.slice(text.lastIndexOf("export {") + 8).split("}")[0].split(",").map(x => x.trim()).find(x => x.split(" as ")[0] === name);
  assert.ok(entry, "Exported " + name);
  return (await import(path.join(dist, file)))[entry.split(" as ")[1] || name];
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-subscription-proof-"));
try {
  Object.assign(process.env, { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"), OPENCLAW_AGENT_DIR: path.join(root, "agents/main/agent"), CODEX_HOME: path.join(root, "codex"), BACKEND_BASE_URL: "https://dev-api.golemworkers.com" });
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"]) delete process.env[key];
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  // Fake only service control. The route resolver and auth schema writer are real.
  const bin = path.join(root, "bin"); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "systemctl"), '#!/bin/sh\nif [ "$2" = "show" ]; then case "$5" in ActiveState) echo active ;; SubState) echo running ;; Result) echo success ;; esac; fi\nexit 0\n', { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.OPENCLAW_GATEWAY_UNIT_PATH = path.join(root, "gateway.service");
  process.env.OPENCLAW_GATEWAY_DROP_IN_DIR = path.join(root, "gateway.service.d");
  await fs.writeFile(configPath, "{}");
  await writeRuntimeAuth({ configPath, profileId: "openai:synthetic", credential: { type: "oauth", provider: "openai", access: "synthetic-access", refresh: "synthetic-refresh", expires: 4_700_000_000_000 } });
  const dbPath = path.join(root, "state/openclaw.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const cell = key => JSON.parse(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key=?").get(key).value_json);
  const store = cell("authProfiles.store"), state = cell("authProfiles.state"); db.close();
  const authBefore = await fs.readFile(dbPath);
  const resolve = await runtimeFunction("openai-model-routes-", "resolveOpenAIModelRoutes");
  const select = await runtimeFunction("provider-model-route-auth-", "selectProviderModelRouteAuth");
  const plan = await runtimeFunction("provider-model-route-auth-", "buildProviderModelAuthSourcePlan");
  const selectConfig = (config, modelId) => {
    const model = config.models?.providers?.openai?.models?.find(m => m.id === modelId);
    const resolution = resolve({ config, provider: "openai", modelId, api: model?.api, agentId: "main", primaryModel: { provider: "openai", model: modelId }, env: {}, resolveProfileAuthMode: id => store.profiles[id]?.type });
    return select({ provider: "openai", resolution, sourcePlan: plan({ explicitOrder: true, profiles: state.order.openai.map(profileId => ({ profileId, mode: store.profiles[profileId].type, readiness: "ready", cooldown: "clear" })) }) });
  };
  for (const modelId of ["gpt-5.4", "gpt-6.1-sol"]) {
    // Migrated override plus lingering codex alias; no manual repair after baseline.
    const row = { baseUrl: process.env.BACKEND_BASE_URL + "/api/v1/relays/openai/v1", models: [] };
    const cfg = { agents: { defaults: { model: { primary: "openai/" + modelId }, thinkingDefault: "high" } }, auth: { order: { openai: ["openai:synthetic"] } }, models: { providers: { openai: row, codex: row } } };
    await fs.writeFile(configPath, JSON.stringify(cfg));
    const before = selectConfig(cfg, modelId);
    assert.equal(before.kind, "rejected");
    assert.equal(before.message, "Explicit auth order for openai has no usable profiles.");
    await executeAgentControl({ configPath, action: { kind: "model.set", model: "openai/" + modelId, fallbacks: [], thinkingDefault: "high" }, gateway: { request() { throw Error("Unexpected gateway RPC"); } } });
    const afterConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    const after = selectConfig(afterConfig, modelId);
    assert.equal(after.kind, "selected");
    assert.equal(after.selection.route.authRequirement, "subscription");
    assert.equal(after.selection.route.api, "openai-chatgpt-responses");
    assert.equal(afterConfig.models.providers.codex, undefined);
    assert.deepEqual(afterConfig.auth, cfg.auth);
    assert.deepEqual(await fs.readFile(dbPath), authBefore);
    console.log(JSON.stringify({ runtimeVersion, model: modelId, before: before.message, after: after.selection.route, authUnchanged: true, lingeringCodexAbsent: true, inference: "not attempted" }));
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
