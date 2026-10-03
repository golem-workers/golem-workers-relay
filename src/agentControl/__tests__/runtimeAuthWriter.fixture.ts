// Legacy storage contract fixture for fast relay orchestration tests. Real
// installed OpenClaw schema admission is covered by runtimeAuthWriter.test.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function legacyRuntimeAuthWriter(input: {
  configPath: string; profileId: string; credential: Record<string, unknown>;
}): Promise<void> {
  const root = path.dirname(input.configPath);
  const shared = path.join(root, "state", "openclaw.sqlite");
  const agent = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  const isShared = await fs.access(shared).then(() => true, () => false);
  const target = isShared ? shared : agent;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  try {
    if (!isShared) db.exec("CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER); CREATE TABLE IF NOT EXISTS auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT, updated_at INTEGER)");
    const read = (state: boolean): Record<string, unknown> => {
      const row = db.prepare(isShared ? "SELECT value_json AS value FROM config_machine_state WHERE state_key = ?" : state ? "SELECT state_json AS value FROM auth_profile_state WHERE state_key = ?" : "SELECT store_json AS value FROM auth_profile_store WHERE store_key = ?").get(isShared ? state ? "authProfiles.state" : "authProfiles.store" : "primary") as { value: string } | undefined;
      return row ? JSON.parse(row.value) as Record<string, unknown> : { version: 1 };
    };
    const store = read(false);
    store.profiles = { ...Object.fromEntries(Object.entries((store.profiles ?? {}) as Record<string, Record<string, unknown>>).filter(([, v]) => !(v.type === "oauth" && ["openai", "openai-codex"].includes(String(v.provider))))), [input.profileId]: input.credential };
    const state = read(true);
    state.order = { ...(state.order as object), openai: [input.profileId] };
    state.lastGood = { ...(state.lastGood as object), openai: input.profileId };
    for (const [isState, value] of [[false, store], [true, state]] as const) {
      db.prepare(isShared ? "INSERT OR REPLACE INTO config_machine_state VALUES (?, ?, ?)" : isState ? "INSERT OR REPLACE INTO auth_profile_state VALUES (?, ?, ?)" : "INSERT OR REPLACE INTO auth_profile_store VALUES (?, ?, ?)").run(isShared ? isState ? "authProfiles.state" : "authProfiles.store" : "primary", JSON.stringify(value), Date.now());
    }
  } finally { db.close(); }
}
