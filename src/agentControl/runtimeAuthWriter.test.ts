import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeAuthSdk, writeRuntimeAuth, writeRuntimeAuthPool } from "./runtimeAuthWriter.js";
import { syncCodexAuthBundle } from "./codexLogin.js";

const roots: string[] = [];
const previousCodexHome = process.env.CODEX_HOME;
afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const sdk = await resolveRuntimeAuthSdk().catch(() => null);
const credential = { type: "oauth", provider: "openai", access: "synthetic-access", refresh: "synthetic-refresh", expires: 4_700_000_000_000 };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-real-auth-"));
  roots.push(root);
  process.env.CODEX_HOME = path.join(root, "codex");
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, "{}");
  return { root, configPath, profileId: "openai:synthetic", credential };
}
function inspect(root: string, agent = false) {
  const db = new DatabaseSync(path.join(root, agent ? "agents/main/agent/openclaw-agent.sqlite" : "state/openclaw.sqlite"), { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      meta: db.prepare("SELECT role, agent_id, schema_version FROM schema_meta").get(),
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
      store: JSON.parse(String(db.prepare(agent ? "SELECT store_json AS value FROM auth_profile_store WHERE store_key='primary'" : "SELECT value_json AS value FROM config_machine_state WHERE state_key='authProfiles.store'").get()?.value ?? "null")) as { profiles: Record<string, unknown> } | null,
    };
  } finally { db.close(); }
}

describe.skipIf(!sdk)("installed OpenClaw public auth SDK (synthetic credentials only)", () => {
  it("verifies already-written pool credentials without rewriting them and refuses a changed token", async () => {
    const input = await fixture();
    await fs.writeFile(input.configPath, JSON.stringify({ agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: { main: {} } } }));
    const { prepareSubscriptionPool } = await import("./openAiSubscriptionPool.js");
    const members = [{ accountId: "a", credentialVersion: 1, enabled: true, credential: { ...credential, type: "oauth" as const, provider: "openai" as const } }];
    const state = prepareSubscriptionPool(null, 1, members);
    await writeRuntimeAuthPool({ ...input, state, members });
    const before = inspect(input.root).store;
    await writeRuntimeAuthPool({ ...input, state, members, reconcileOnly: true });
    expect(inspect(input.root).store).toEqual(before);
    const changed = [{ ...members[0], credentialVersion: 2, credential: { ...members[0].credential, access: "synthetic-newer-access" } }];
    await expect(writeRuntimeAuthPool({ ...input, state: prepareSubscriptionPool(state, 1, changed), members: changed, reconcileOnly: true })).rejects.toMatchObject({ code: "AUTH_POOL_WRITER_STORE_READBACK_MISMATCH_EXIT_16_NONE" });
    expect(inspect(input.root).store).toEqual(before);
  }, 30_000);
  it.each([false, true])("verifies SDK-normalized empty order after removal/disable (disabled=%s) without a store save", async disabled => {
    const input = await fixture();
    await fs.writeFile(input.configPath, JSON.stringify({ agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: { main: {} } } }));
    const { prepareSubscriptionPool } = await import("./openAiSubscriptionPool.js");
    const member = { accountId: "a", credentialVersion: 1, enabled: true, credential: { ...credential, type: "oauth" as const, provider: "openai" as const } };
    const first = prepareSubscriptionPool(null, 1, [member]);
    await writeRuntimeAuthPool({ ...input, state: first, members: [member] });
    const members = disabled ? [{ ...member, enabled: false }] : [];
    const empty = prepareSubscriptionPool(first, 2, members);
    await writeRuntimeAuthPool({ ...input, state: empty, members });
    const readRow = () => { const db = new DatabaseSync(path.join(input.root, "state/openclaw.sqlite"), { readOnly: true }); try { return db.prepare("SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key='authProfiles.store'").get(); } finally { db.close(); } };
    const before = readRow();
    await writeRuntimeAuthPool({ ...input, state: empty, members, reconcileOnly: true });
    expect(readRow()).toEqual(before);
  }, 30_000);
  it("refuses a nonempty OpenAI order even when the expected pool is empty", async () => {
    const input = await fixture();
    await fs.writeFile(input.configPath, JSON.stringify({ agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: { main: {} } } }));
    await writeRuntimeAuth({ ...input, profileId: "openai:key", credential: { type: "api_key", provider: "openai", key: "synthetic" } });
    const { prepareSubscriptionPool } = await import("./openAiSubscriptionPool.js");
    const state = prepareSubscriptionPool(null, 1, []);
    const env = { ...process.env, OPENCLAW_STATE_DIR: input.root, OPENCLAW_CONFIG_PATH: input.configPath, OPENCLAW_AGENT_DIR: path.join(input.root, "agents/main/agent") };
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      const { updateAuthProfileStoreWithLock } = await import(process.argv[1]);
      await updateAuthProfileStoreWithLock({agentDir:process.env.OPENCLAW_AGENT_DIR,stateDir:process.env.OPENCLAW_STATE_DIR,sharedStoreWrite:true,saveOptions:{syncExternalCli:false,filterExternalAuthProfiles:false},updater(store){store.order={...store.order,openai:["openai:key"]};return true;}});
    `, pathToFileURL(sdk!).href], { env });
    const before = inspect(input.root).store;
    await expect(writeRuntimeAuthPool({ ...input, state, members: [], reconcileOnly: true })).rejects.toMatchObject({ code: "AUTH_POOL_WRITER_STORE_READBACK_MISMATCH_EXIT_16_NONE" });
    expect(inspect(input.root).store).toEqual(before);
  }, 30_000);
  it("preserves A, an API key, and another provider when adding B through the installed SDK", async () => {
    const input = await fixture();
    const { prepareSubscriptionPool } = await import("./openAiSubscriptionPool.js");
    const members = ["a", "b"].map(accountId => ({ accountId, credentialVersion: 1, enabled: true, credential: { ...credential, type: "oauth" as const, provider: "openai" as const, accountId } }));
    await writeRuntimeAuth({ ...input, profileId: "anthropic:keep", credential: { type: "api_key", provider: "anthropic", key: "synthetic" } });
    await writeRuntimeAuth({ ...input, profileId: "openai:key", credential: { type: "api_key", provider: "openai", key: "synthetic" } });
    await writeRuntimeAuth({ ...input, profileId: "openai:legacy-a", credential: { ...credential, accountId: "a" } });
    await fs.writeFile(input.configPath, JSON.stringify({ agents: { ownership: "explicit", defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, child: {} } } }));
    const sessionSdk = path.join(path.dirname(sdk!), "session-store-runtime.js");
    const env = { ...process.env, OPENCLAW_STATE_DIR: input.root, OPENCLAW_CONFIG_PATH: input.configPath, OPENCLAW_AGENT_DIR: path.join(input.root,"agents/main/agent") };
    await promisify(execFile)(process.execPath,["--input-type=module","-e",`
      const { upsertSessionEntry, resolveStorePath } = await import(process.argv[1]);
      for (const agentId of ["main", "child"]) await upsertSessionEntry({agentId,env:process.env,sessionKey:"agent:"+agentId+":pool-proof",storePath:resolveStorePath(undefined,{agentId,env:process.env}),maintenanceConfig:{mode:"off"},entry:{sessionId:"history-preserved-"+agentId,updatedAt:1234,inputTokens:42,authProfileOverride:"openai:legacy-a",authProfileOverrideSource:"user"},requireWriteSuccess:true});
    `,pathToFileURL(sessionSdk).href],{env});
    const first = prepareSubscriptionPool(null, 1, [members[0]]);
    await writeRuntimeAuthPool({ ...input, state: first, members: [members[0]] });
    const next = prepareSubscriptionPool(first, 2, members);
    await writeRuntimeAuthPool({ ...input, state: next, members });
    const session = await promisify(execFile)(process.execPath,["--input-type=module","-e",`
      const { listSessionEntries, resolveStorePath } = await import(process.argv[1]);
      const result = ["main", "child"].map(agentId => { const entry = listSessionEntries({agentId,env:process.env,storePath:resolveStorePath(undefined,{agentId,env:process.env})}).find(r=>r.sessionKey==="agent:"+agentId+":pool-proof").entry; return {sessionId:entry.sessionId,updatedAt:entry.updatedAt,inputTokens:entry.inputTokens,pin:entry.authProfileOverride??null}; });
      process.stdout.write(JSON.stringify(result));
    `,pathToFileURL(sessionSdk).href],{env});
    expect(JSON.parse(session.stdout)).toEqual(["main", "child"].map(id=>({sessionId:"history-preserved-"+id,updatedAt:1234,inputTokens:42,pin:null})));
    const profiles = inspect(input.root).store?.profiles;
    expect(profiles?.["openai:legacy-a"]).toBeUndefined();
    expect(Object.keys(profiles ?? {})).toHaveLength(4);
    expect(profiles?.["openai:golem-a"]).toMatchObject({ accountId: "a", type: "oauth", refresh: "", copyToAgents: true });
    expect(profiles?.["openai:golem-b"]).toMatchObject({ accountId: "b" });
    expect(profiles?.["openai:key"]).toMatchObject({ type: "api_key" });
    const removed = prepareSubscriptionPool(next, 3, [members[1]]);
    await writeRuntimeAuthPool({ ...input, state: removed, members: [members[1]] });
    expect(inspect(input.root).store?.profiles["openai:golem-a"]).toBeUndefined();
    expect(inspect(input.root).store?.profiles["openai:golem-b"]).toBeDefined();
  }, 30_000);

  it("initializes a sterile modern global DB with no marker without an auth-only agent DB", async () => {
    const input = await fixture();
    // Bootstrap through the runtime, then return the global store to sterile
    // auth state. Never manufacture schema_meta or PRAGMA user_version.
    await writeRuntimeAuth(input);
    const db = new DatabaseSync(path.join(input.root, "state/openclaw.sqlite"));
    db.exec("DELETE FROM config_machine_state WHERE state_key IN ('auth.sharedStore','authProfiles.store','authProfiles.state')");
    db.close();
    const before = inspect(input.root);
    await writeRuntimeAuth(input);
    const after = inspect(input.root);
    expect(after.meta).toEqual(before.meta);
    expect(after.version).toBeGreaterThan(0);
    expect(after.integrity).toBe("ok");
    expect(after.store?.profiles[input.profileId]).toMatchObject(credential);
    await expect(fs.access(path.join(input.root, "agents/main/agent/openclaw-agent.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(input.root, "agents/main/agent/auth-profiles.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const owner = new DatabaseSync(path.join(input.root, "state/openclaw.sqlite"), { readOnly: true });
    expect(owner.prepare("SELECT value_json FROM config_machine_state WHERE state_key='auth.sharedStore'").get()?.value_json).toBe('{"location":"state-db"}');
    owner.close();
  }, 30_000);

  it("preserves existing shared ownership and unrelated provider profiles", async () => {
    const input = await fixture();
    await writeRuntimeAuth({ ...input, profileId: "anthropic:keep", credential: { type: "api_key", provider: "anthropic", key: "synthetic-only" } });
    const before = inspect(input.root);
    await writeRuntimeAuth(input);
    expect(inspect(input.root).meta).toEqual(before.meta);
    expect(inspect(input.root).store?.profiles["anthropic:keep"]).toEqual(before.store?.profiles["anthropic:keep"]);
    expect(inspect(input.root).store?.profiles[input.profileId]).toMatchObject(credential);
  }, 30_000);

  it("initializes and preserves legacy agent ownership through the runtime schema owner", async () => {
    const input = await fixture();
    const agentDir = path.join(input.root, "agents/main/agent");
    await fs.mkdir(agentDir, { recursive: true });
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      const { updateAuthProfileStoreWithLock } = await import(process.argv[1]);
      const result = await updateAuthProfileStoreWithLock({
        agentDir: process.env.OPENCLAW_AGENT_DIR,
        updater: (store) => { store.profiles["anthropic:keep"] = { type: "api_key", provider: "anthropic", key: "synthetic" }; return true; },
      });
      process.exit(result ? 0 : 1);
    `, pathToFileURL(sdk!).href], { env: { ...process.env, OPENCLAW_STATE_DIR: input.root, OPENCLAW_CONFIG_PATH: input.configPath, OPENCLAW_AGENT_DIR: agentDir } });
    await writeRuntimeAuth(input);
    const before = inspect(input.root, true);
    expect(before.meta).toMatchObject({ role: "agent", agent_id: "main" });
    expect(before.version).toBeGreaterThan(0);
    await writeRuntimeAuth({ ...input, credential: { ...credential, refresh: "synthetic-new" } });
    expect(inspect(input.root, true).meta).toEqual(before.meta);
    expect(inspect(input.root, true).integrity).toBe("ok");
    expect(inspect(input.root, true).store?.profiles[input.profileId]).toMatchObject({ refresh: "synthetic-new" });
  }, 30_000);

  it("refuses an existing malformed auth-only database instead of forging ownership", async () => {
    const input = await fixture();
    const agentDir = path.join(input.root, "agents/main/agent");
    await fs.mkdir(agentDir, { recursive: true });
    const file = path.join(agentDir, "openclaw-agent.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER); CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)").run(JSON.stringify({ version: 1, profiles: { untouched: credential } }));
    db.close();
    const before = await fs.readFile(file);
    await expect(writeRuntimeAuth(input)).rejects.toThrow("refused");
    expect(await fs.readFile(file)).toEqual(before);
  }, 30_000);

  it("rolls back a failed fresh sync without deleting runtime schema or leaving OAuth behind", async () => {
    const input = await fixture();
    const token = Buffer.from("{}").toString("base64url") + "." + Buffer.from(JSON.stringify({ exp: 4700000000, "https://api.openai.com/profile": { email: "test@example.com" } })).toString("base64url") + ".signature";
    await expect(syncCodexAuthBundle(input.configPath, 1, {
      formatVersion: 1, profileId: "openai:test@example.com", accessToken: token,
      idToken: token, refreshToken: "synthetic-refresh", expiresAtMs: 4700000000000,
      lastRefresh: null, email: "test@example.com", accountId: null, chatgptPlanType: null,
    }, { refreshRuntimeAuth: () => Promise.reject(new Error("synthetic refresh failure")) })).rejects.toThrow();
    const after = inspect(input.root);
    expect(after.meta).toMatchObject({ role: "global" });
    expect(after.integrity).toBe("ok");
    expect(after.store).toBeNull();
    await expect(fs.access(path.join(input.root, "agents/main/agent/openclaw-agent.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
