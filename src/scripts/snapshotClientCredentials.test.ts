import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const helper = join(process.cwd(), 'scripts/bootstrap-snapshot-client-credentials.mjs');
function fixture(version = 36) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-client-'));
  roots.push(root);
  mkdirSync(join(root, 'state'));
  const db = new DatabaseSync(join(root, 'state/openclaw.sqlite'));
  db.exec(`CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY,schema_version INTEGER,created_at INTEGER,updated_at INTEGER);
    INSERT INTO schema_meta VALUES ('primary',${version},0,0);
    CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT);
    INSERT INTO config_machine_state VALUES ('plugins.installedIndex','{}');
    CREATE TABLE private_records(value TEXT);`);
  db.close();
  return root;
}
function change(root: string, sql: string) {
  const db = new DatabaseSync(join(root, 'state/openclaw.sqlite'));
  db.exec(sql); db.close();
}
function run(root: string) {
  return spawnSync(process.execPath, [helper, root, join(root, 'not-an-installed-runtime')], { encoding: 'utf8' });
}
function refuses(root: string, error: string) {
  const before = readFileSync(join(root, 'state/openclaw.sqlite'));
  const result = run(root);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(readFileSync(join(root, 'state/openclaw.sqlite'))).toEqual(before);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('fresh-only native snapshot credential bootstrap', () => {
  it('leaves pre-cutover state unchanged without loading a native API', () => {
    const root = fixture(28), before = readFileSync(join(root, 'state/openclaw.sqlite'));
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ skipped: true, reason: 'pre-client-credential-cutover' });
    expect(readFileSync(join(root, 'state/openclaw.sqlite'))).toEqual(before);
    expect(existsSync(join(root, 'client'))).toBe(false);
  });
  it.each([
    ["UPDATE schema_meta SET created_at=123", 'SNAPSHOT_SHARED_STATE_NOT_SEALED'],
    ["UPDATE schema_meta SET updated_at=123", 'SNAPSHOT_SHARED_STATE_NOT_SEALED'],
    ["INSERT INTO private_records VALUES ('private-identity-sentinel')", 'SNAPSHOT_SHARED_STATE_NOT_EMPTY'],
    ["INSERT INTO schema_meta VALUES ('state-migrations',3,0,0)", 'SNAPSHOT_SHARED_STATE_NOT_EMPTY'],
    ["INSERT INTO config_machine_state VALUES ('auth.sharedStore','private-token-sentinel')", 'SNAPSHOT_SHARED_STATE_NOT_EMPTY'],
  ])('refuses non-pristine shared state before native effects: %s', (sql, error) => {
    const root = fixture(); change(root, sql); refuses(root, error);
    expect(existsSync(join(root, 'client'))).toBe(false);
  });
  it('refuses unknown native APIs before creating a companion or changing shared state', () => {
    const root = fixture();
    mkdirSync(join(root, 'not-an-installed-runtime/dist'), { recursive: true });
    refuses(root, 'SNAPSHOT_NATIVE_CREDENTIAL_API_UNAVAILABLE');
    expect(existsSync(join(root, 'client'))).toBe(false);
  });
  it('preserves an existing credential store instead of resetting or replacing it', () => {
    const root = fixture(); mkdirSync(join(root, 'client'));
    const credentials = join(root, 'client/credentials.sqlite'); writeFileSync(credentials, 'private-identity-sentinel');
    refuses(root, 'SNAPSHOT_CLIENT_STORE_ALREADY_EXISTS');
    expect(readFileSync(credentials, 'utf8')).toBe('private-identity-sentinel');
  });
  it('refuses dangling credential-directory links before any native effects', () => {
    const root = fixture(); symlinkSync(join(root, 'absent'), join(root, 'client'));
    refuses(root, 'SNAPSHOT_CLIENT_STORE_ALREADY_EXISTS');
    expect(existsSync(join(root, 'absent'))).toBe(false);
  });
  it('refuses a symlinked shared database without opening it for mutation', () => {
    const root = fixture(), original = join(root, 'state/original.sqlite');
    writeFileSync(original, readFileSync(join(root, 'state/openclaw.sqlite')));
    rmSync(join(root, 'state/openclaw.sqlite')); symlinkSync(original, join(root, 'state/openclaw.sqlite'));
    refuses(root, 'SNAPSHOT_CREDENTIAL_SYMLINK');
  });
});
