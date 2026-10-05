import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(resolve("scripts/prepare-agent-server.sh"), "utf8");
const sealSection = script.split('set_step "openclaw_snapshot_identity_seal"')[1];
const seal = sealSection.split("<<'SEAL_PY'\n")[1].split("\nSEAL_PY")[0];
type PluginIndex = {
  version?: number;
  installRecords: Record<string, { integrity: string }>;
  plugins: Record<string, unknown>[];
  diagnostics: unknown[];
  workspaceDir?: string;
};
const roots: string[] = [];
const secret = "BAKE_PRIVATE_KEY_SENTINEL_NEVER_RETAIN";
const setup = String.raw`
import json, pathlib, sqlite3
s = root / '.openclaw'
(s / 'state').mkdir(parents=True)
records = {}
for name in ('codex', 'whatsapp', 'moonshot', 'perplexity', 'relay-channel'):
    directory = s / 'extensions' / name
    (directory / 'dist').mkdir(parents=True)
    (directory / 'dist/index.js').write_text('export {};')
    (directory / 'openclaw.plugin.json').write_text(json.dumps({'id': name}))
    records[name] = {'source': 'npm', 'installPath': str(directory), 'spec': name + '@1.0.0', 'integrity': 'sha512-provenance'}
config = {'gateway': {'auth': {'mode': 'token', 'token': secret, 'password': secret}}, 'plugins': {'installs': records}}
(s / 'openclaw.json').write_text(json.dumps(config))
index = {'version': 1, 'installRecords': records, 'plugins': [{'id': name, 'sourceAdmissions': [secret]} for name in records], 'diagnostics': [secret], 'workspaceDir': secret, 'generatedAtMs': 999, 'refreshReason': 'bake'}
(s / 'plugins').mkdir()
(s / 'plugins/installs.json').write_text(json.dumps(index))
for name in ('openclaw.json.bak', 'openclaw.json.bak.1', 'openclaw.json.last-good', 'config-journal-fingerprint.key', 'identity/device.json', 'agents/main/agent/secret', 'credentials/auth.json', 'future-runtime/secret', 'state/old.sqlite', 'state/old.sqlite-wal', 'state/old.sqlite-shm', 'state/old.sqlite-journal', 'plugins/runtime-secret', 'workspace/IDENTITY.md', 'workspace/memory/private.md', 'cache/private'):
    file = s / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(secret)
for name in ('workspace/skills/example/SKILL.md', 'plugin-skills/example/SKILL.md', 'cache/control-ui-assets/index.html', 'npm/node_modules/payload/index.js'):
    file = s / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text('KEEP')
for name in ('.config/go/telemetry/local/upload.token', '.cache/go/telemetry/token', '.bash_history', '.node_repl_history', '.python_history'):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(secret)
if modern:
    c = sqlite3.connect(s / 'state/openclaw.sqlite')
    c.executescript('''
    CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    INSERT INTO schema_meta VALUES ('primary','global',13,NULL,'2026.9.8',123,456);
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT;
    CREATE TABLE device_identities (private_key_pem TEXT);
    CREATE TABLE config_revision_keys (hmac_key TEXT);
    CREATE TABLE task_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT);
    CREATE INDEX task_data ON task_runs(data);
    CREATE VIEW task_view AS SELECT * FROM task_runs;
    CREATE VIRTUAL TABLE task_fts USING fts5(data);
    CREATE TRIGGER task_search AFTER INSERT ON task_runs BEGIN INSERT INTO task_fts(rowid,data) VALUES(new.id,new.data); END;
    PRAGMA user_version=13;
    ''')
    c.execute('INSERT INTO config_machine_state VALUES (?,?,?)', ('plugins.installedIndex', json.dumps({'revision': 99, 'index': index}), 999))
    c.execute('INSERT INTO config_machine_state VALUES (?,?,?)', ('auth.sharedStore', json.dumps({'secret': secret}), 999))
    for table in ('device_identities', 'config_revision_keys'):
        c.execute('INSERT INTO ' + table + ' VALUES (?)', (secret,))
    c.execute('INSERT INTO task_runs(data) VALUES (?)', (secret,))
    c.commit()
    c.close()
`;

function python(root: string, input: string, modern = true) {
  return spawnSync("python3", ["-"], {
    input: "import pathlib\nroot = pathlib.Path(" + JSON.stringify(root) + ")\nsecret = " + JSON.stringify(secret) + "\nmodern = " + (modern ? "True" : "False") + "\n" + input,
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_AUTHORED_PLUGIN_INSTALLS: modern ? "0" : "1" },
  });
}
function fixture(modern = true) {
  const root = mkdtempSync(join(tmpdir(), "identity-seal-"));
  roots.push(root);
  const result = python(root, setup, modern);
  expect(result.status, result.stderr).toBe(0);
  return root;
}
function runSeal(root: string, modern = true, prefix = "") {
  return python(root, prefix + seal.replace("root = pathlib.Path('/root')", "# root supplied by test").replace("machine_state = root.parent / 'var/lib/golem-workers'", "machine_state = root / 'machine-state'"), modern);
}
function query(root: string, sql: string) {
  const result = python(root, "import sqlite3,json\nc=sqlite3.connect(root / '.openclaw/state/openclaw.sqlite')\nprint(json.dumps(c.execute(" + JSON.stringify(sql) + ").fetchall()))");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown[][];
}
function mutate(root: string, code: string) {
  const result = python(root, "import sqlite3,json\nc=sqlite3.connect(root / '.openclaw/state/openclaw.sqlite')\n" + code + "\nc.commit()\nc.close()\n");
  expect(result.status, result.stderr).toBe(0);
}
function unchangedFailure(root: string, message: string, modern = true, prefix = "") {
  const config = readFileSync(join(root, ".openclaw/openclaw.json"));
  const db = join(root, ".openclaw/state/openclaw.sqlite");
  const before = existsSync(db) ? readFileSync(db) : null;
  const result = runSeal(root, modern, prefix);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(readFileSync(join(root, ".openclaw/openclaw.json"))).toEqual(config);
  if (before) expect(readFileSync(db)).toEqual(before);
  expect(readdirSync(join(root, ".openclaw")).some((name) => name.startsWith(".snapshot-seal-"))).toBe(false);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("offline snapshot identity sealing", () => {
  it("reconstructs only plugin provenance and schema, including FTS, indexes, views and triggers", () => {
    const root = fixture();
    const result = runSeal(root);
    expect(result.status, result.stderr).toBe(0);
    expect(query(root, "PRAGMA integrity_check")).toEqual([["ok"]]);
    expect(query(root, "PRAGMA user_version")).toEqual([[13]]);
    expect(query(root, "SELECT state_key FROM config_machine_state")).toEqual([["plugins.installedIndex"]]);
    for (const table of ["device_identities", "config_revision_keys", "task_runs", "task_fts", "sqlite_sequence"])
      expect(query(root, "SELECT count(*) FROM " + table)).toEqual([[0]]);
    expect(query(root, "SELECT created_at,updated_at FROM schema_meta")).toEqual([[0, 0]]);
    expect(query(root, "SELECT name FROM sqlite_master WHERE type IN ('index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name")).toEqual([["task_data"], ["task_search"], ["task_view"]]);
    const payload = JSON.parse(String(query(root, "SELECT value_json FROM config_machine_state")[0][0])) as { revision: number; index: PluginIndex };
    expect(payload.revision).toBe(1);
    expect(payload.index.installRecords.whatsapp.integrity).toBe("sha512-provenance");
    expect(payload.index.plugins.every((plugin: Record<string, unknown>) => !("sourceAdmissions" in plugin))).toBe(true);
    expect(payload.index.diagnostics).toEqual([]);
    expect(payload.index.workspaceDir).toBeUndefined();
    expect(readFileSync(join(root, ".openclaw/state/openclaw.sqlite")).includes(Buffer.from(secret))).toBe(false);
    expect(statSync(join(root, ".openclaw/state/openclaw.sqlite")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, ".openclaw/state")).mode & 0o777).toBe(0o700);
    expect(runSeal(root).status).toBe(0); // repeatable without regenerating identity
  });

  it("strips agent-bound harness and owner authority only during fresh image sealing", () => {
    const root = fixture();
    const machine = join(root, "machine-state");
    mkdirSync(join(machine, "owner-fence"), { recursive: true });
    writeFileSync(join(machine, "managed-runtime-policy.json"), JSON.stringify({ schemaVersion: 2, serverId: "source-agent", globalRevision: 4, revision: 7, harnessOverride: "codex", defaultHarness: "openclaw", chatHarness: "codex" }));
    writeFileSync(join(machine, "owner-fence", "openclaw.json.owner-fence.json"), secret);
    const result = runSeal(root);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(machine)).toBe(false);
    expect(script).toContain("fresh-bake seal");
  });
  it("reads committed WAL provenance and discards WAL/SHM without copying secret pages", () => {
    const root = fixture();
    const wal = python(root, "import sqlite3,os\nc=sqlite3.connect(root / '.openclaw/state/openclaw.sqlite')\nc.execute('PRAGMA journal_mode=WAL')\nc.execute(\"UPDATE config_machine_state SET updated_at_ms=9999 WHERE state_key='plugins.installedIndex'\")\nc.execute('INSERT INTO device_identities VALUES (?)', (secret,))\nc.commit()\nos._exit(0)\n");
    expect(wal.status, wal.stderr).toBe(0);
    expect(existsSync(join(root, ".openclaw/state/openclaw.sqlite-wal"))).toBe(true);
    const result = runSeal(root);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, ".openclaw/state"))).toEqual(["openclaw.sqlite"]);
    expect(query(root, "SELECT updated_at_ms FROM config_machine_state")).toEqual([[0]]);
    expect(readFileSync(join(root, ".openclaw/state/openclaw.sqlite")).includes(Buffer.from(secret))).toBe(false);
  });

  it("removes credentials, backups, histories, unknown state and all old SQLite sidecars", () => {
    const root = fixture();
    expect(runSeal(root).status).toBe(0);
    const config = JSON.parse(readFileSync(join(root, ".openclaw/openclaw.json"), "utf8")) as { gateway: { auth: Record<string, unknown> } };
    expect(config.gateway.auth).toEqual({ mode: "token" });
    expect(statSync(join(root, ".openclaw/openclaw.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, ".openclaw")).sort()).toEqual(["cache", "extensions", "npm", "openclaw.json", "plugin-skills", "state", "workspace"]);
    expect(readdirSync(join(root, ".openclaw/state"))).toEqual(["openclaw.sqlite"]);
    expect(readdirSync(join(root, ".openclaw/workspace"))).toEqual(["skills"]);
    expect(readdirSync(join(root, ".openclaw/cache"))).toEqual(["control-ui-assets"]);
    for (const name of ["workspace/skills/example/SKILL.md", "plugin-skills/example/SKILL.md", "cache/control-ui-assets/index.html", "npm/node_modules/payload/index.js"])
      expect(readFileSync(join(root, ".openclaw", name), "utf8")).toBe("KEEP");
    for (const name of [".config/go/telemetry", ".cache/go/telemetry", ".bash_history", ".node_repl_history", ".python_history"])
      expect(existsSync(join(root, name))).toBe(false);
  });

  it("supports legacy no-database config and install-index provenance", () => {
    const root = fixture(false);
    const result = runSeal(root, false);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, ".openclaw/state"))).toEqual([]);
    const index = JSON.parse(readFileSync(join(root, ".openclaw/plugins/installs.json"), "utf8")) as PluginIndex;
    expect(Object.keys(index).sort()).toEqual(["installRecords", "version"]);
    expect(index.version).toBe(1);
    expect(index.installRecords.codex.integrity).toBe("sha512-provenance");
    expect(readdirSync(join(root, ".openclaw/plugins"))).toEqual(["installs.json"]);
    expect(runSeal(root, false).status).toBe(0);
  });
  it("supports legacy config-only provenance without creating an index", () => {
    const root = fixture(false);
    rmSync(join(root, ".openclaw/plugins"), { recursive: true });
    expect(runSeal(root, false).status).toBe(0);
    expect(existsSync(join(root, ".openclaw/plugins"))).toBe(false);
  });
  it("never treats a missing modern database as legacy", () => {
    const root = fixture(false);
    unchangedFailure(root, "Missing modern runtime database");
  });
  it("rejects missing provenance before changing config or database", () => {
    const root = fixture();
    mutate(root, "c.execute(\"DELETE FROM config_machine_state WHERE state_key='plugins.installedIndex'\")");
    unchangedFailure(root, "Missing required plugin provenance");
  });
  it("rejects malformed plugin provenance", () => {
    const root = fixture();
    mutate(root, "c.execute(\"UPDATE config_machine_state SET value_json='{}' WHERE state_key='plugins.installedIndex'\")");
    unchangedFailure(root, "Invalid installed plugin index");
  });
  it("discards known startup migration checkpoints while retaining only primary schema metadata", () => {
    const root = fixture();
    mutate(root, "c.executemany(\"INSERT INTO schema_meta VALUES (?, 'global', 3, NULL, ?, 123, 456)\", [(key, secret) for key in ('startup-migrations', 'state-migrations')])");
    const result = runSeal(root);
    expect(result.status, result.stderr).toBe(0);
    expect(query(root, "SELECT meta_key FROM schema_meta")).toEqual([["primary"]]);
  });
  it.each(["agent", "future-version"])("rejects invalid migration checkpoint %s", (kind) => {
    const root = fixture();
    mutate(root, "c.execute(\"INSERT INTO schema_meta VALUES ('startup-migrations', 'global', 3, NULL, 'checkpoint', 123, 456)\")");
    mutate(root, kind === "agent"
      ? "c.execute(\"UPDATE schema_meta SET agent_id='baked-agent' WHERE meta_key='startup-migrations'\")"
      : "c.execute(\"UPDATE schema_meta SET schema_version=99 WHERE meta_key='startup-migrations'\")");
    unchangedFailure(root, "Unsupported global schema metadata");
  });
  it("rejects unknown schema metadata keys", () => {
    const root = fixture();
    mutate(root, "c.execute(\"INSERT INTO schema_meta VALUES ('future-state', 'global', 3, NULL, 'value', 123, 456)\")");
    unchangedFailure(root, "Unsupported global schema metadata");
  });
  it("rejects unfamiliar schema metadata", () => {
    const root = fixture();
    mutate(root, "c.execute('ALTER TABLE schema_meta ADD COLUMN future TEXT')");
    unchangedFailure(root, "Unsupported schema metadata");
  });
  it("does not copy a non-global schema identity", () => {
    const root = fixture();
    mutate(root, "c.execute(\"UPDATE schema_meta SET agent_id='baked-agent'\")");
    unchangedFailure(root, "Unsupported global schema metadata");
  });
  it("fails closed on corrupt SQLite rather than treating it as absent", () => {
    const root = fixture();
    writeFileSync(join(root, ".openclaw/state/openclaw.sqlite"), "not a database");
    unchangedFailure(root, "file is not a database");
  });
  it("fails on fsync errors before publishing staged config or state", () => {
    const root = fixture();
    unchangedFailure(root, "injected fsync failure", true, "import os\ndef fail(fd):\n    raise OSError('injected fsync failure')\nos.fsync = fail\n");
  });
  it.each(["state", "cache", "workspace", "extensions", "cache/control-ui-assets", "workspace/skills"])("rejects a retained symlink at %s", (name) => {
    const root = fixture();
    const path = join(root, ".openclaw", name);
    rmSync(path, { recursive: true, force: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "untouched"), "KEEP");
    symlinkSync(outside, path);
    unchangedFailure(root, "Refusing symlink");
    expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("KEEP");
  });
  it("unlinks unknown symlinks instead of traversing their targets", () => {
    const root = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "untouched"), "KEEP");
    symlinkSync(outside, join(root, ".openclaw/future-link"));
    expect(runSeal(root).status).toBe(0);
    expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("KEEP");
  });
  it("rejects install paths that cleanup would discard", () => {
    const root = fixture();
    const outside = join(root, "custom-codex");
    mkdirSync(join(outside, "dist"), { recursive: true });
    writeFileSync(join(outside, "openclaw.plugin.json"), '{"id":"codex"}');
    writeFileSync(join(outside, "dist/index.js"), "export {};");
    mutate(root, "p=json.loads(c.execute(\"SELECT value_json FROM config_machine_state WHERE state_key='plugins.installedIndex'\").fetchone()[0])\np['index']['installRecords']['codex']['installPath']=" + JSON.stringify(outside) + "\nc.execute(\"UPDATE config_machine_state SET value_json=? WHERE state_key='plugins.installedIndex'\", (json.dumps(p),))");
    unchangedFailure(root, "Plugin install outside retained paths");
  });

  it.each(["active", "activating", "deactivating", "reloading", "", "unknown"])("refuses gateway state %j before Python runs", (state) => {
    const guard = sealSection.split("  python3 - <<'SEAL_PY'")[0];
    const result = spawnSync("bash", ["-c", "set -e\nsystemctl() { printf '%s' " + JSON.stringify(state) + "; }\ncheck() {\n" + guard + "\necho SHOULD_NOT_RUN\n}\ncheck"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
  });
  it("fails closed when systemd cannot confirm the stopped state", () => {
    const guard = sealSection.split("  python3 - <<'SEAL_PY'")[0];
    const result = spawnSync("bash", ["-c", "set -e\nsystemctl() { return 1; }\ncheck() {\n" + guard + "\necho SHOULD_NOT_RUN\n}\ncheck"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
  });
  it.each(["inactive", "failed"])("allows stopped gateway state %s", (state) => {
    const guard = sealSection.split("  python3 - <<'SEAL_PY'")[0];
    const result = spawnSync("bash", ["-c", "set -e\nsystemctl() { echo " + state + "; }\ncheck() {\n" + guard + "\necho SAFE_TO_SEAL\n}\ncheck"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SAFE_TO_SEAL");
  });
  it("does not invoke OpenClaw CLI after shutdown/config sealing", () => {
    const tail = script.split('set_step "openclaw_snapshot_shutdown"')[1];
    expect(tail).not.toMatch(/^\s*openclaw\s/gm);
    expect(sealSection.indexOf("sync")).toBeLessThan(sealSection.indexOf('set_step "done"'));
  });
});
