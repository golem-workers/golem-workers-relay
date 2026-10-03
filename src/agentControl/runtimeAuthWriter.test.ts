import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeAuthSdk, writeRuntimeAuth } from "./runtimeAuthWriter.js";
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
