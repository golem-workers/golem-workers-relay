import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Fresh image sealing only. Never repair or erase an existing agent's credentials.
export async function bootstrapSnapshotClientCredentials(stateDir, packageDir) {
  const sharedPath = path.join(stateDir, 'state', 'openclaw.sqlite');
  if (!fs.existsSync(sharedPath)) return { skipped: true, reason: 'legacy-no-shared-sqlite' };
  for (const entry of [stateDir, path.dirname(sharedPath), sharedPath]) {
    if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('SNAPSHOT_CREDENTIAL_SYMLINK');
  }
  const inspect = new DatabaseSync(sharedPath, { readOnly: true });
  let contentVersion;
  try {
    const meta = inspect.prepare("SELECT schema_version,created_at,updated_at FROM schema_meta WHERE meta_key='primary'").get();
    if (!meta) throw new Error('SNAPSHOT_SHARED_SCHEMA_MISSING');
    contentVersion = Number(meta.schema_version);
    if (contentVersion < 29) return { skipped: true, reason: 'pre-client-credential-cutover' };
    if (meta.created_at !== 0 || meta.updated_at !== 0) throw new Error('SNAPSHOT_SHARED_STATE_NOT_SEALED');
    const shadow = new Set(inspect.prepare('PRAGMA table_list').all().filter(row => row.type === 'shadow').map(row => row.name));
    for (const { name } of inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (shadow.has(name) || name === 'schema_meta' || name === 'config_machine_state') continue;
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      if (inspect.prepare(`SELECT count(*) AS count FROM ${quoted}`).get().count !== 0) throw new Error('SNAPSHOT_SHARED_STATE_NOT_EMPTY');
    }
    if (inspect.prepare("SELECT count(*) AS count FROM schema_meta WHERE meta_key!='primary'").get().count !== 0 ||
        inspect.prepare("SELECT count(*) AS count FROM config_machine_state WHERE state_key!='plugins.installedIndex'").get().count !== 0) throw new Error('SNAPSHOT_SHARED_STATE_NOT_EMPTY');
  } finally { inspect.close(); }
  const clientDir = path.join(stateDir, 'client');
  if (fs.lstatSync(clientDir, { throwIfNoEntry: false })) throw new Error('SNAPSHOT_CLIENT_STORE_ALREADY_EXISTS');
  const dist = path.join(packageDir, 'dist');
  // Use the installed runtime's actual custody/bootstrap implementation; never
  // synthesize a migration receipt, schema version, key, token or identity.
  async function nativeExport(prefix, name) {
    for (const file of fs.readdirSync(dist).filter(file => file.startsWith(prefix) && file.endsWith('.mjs')).sort()) {
      const source = fs.readFileSync(path.join(dist, file), 'utf8');
      const exports = source.match(/export \{([^}]+)\}/g)?.join('\n') ?? '';
      const alias = exports.match(new RegExp('\\b' + name + ' as ([A-Za-z_$][\\w$]*)\\b'))?.[1];
      if (alias) {
        const value = (await import(pathToFileURL(path.join(dist, file)).href))[alias];
        if (typeof value !== 'function') throw new Error('SNAPSHOT_NATIVE_CREDENTIAL_API_INVALID');
        return value;
      }
    }
    throw new Error('SNAPSHOT_NATIVE_CREDENTIAL_API_UNAVAILABLE: ' + name);
  }
  const open = await nativeExport('node-sqlite-', 'openNodeSqliteDatabase');
  const transaction = await nativeExport('sqlite-transaction-', 'runSqliteImmediateTransactionSync');
  const bind = await nativeExport('client-credential-migration-', 'bindFreshClientCredentialStore');
  const custody = await nativeExport('client-credential-store-', 'openClientCredentialCustody');
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const shared = open(sharedPath);
  try { transaction(shared, () => bind(shared, { path: sharedPath, env })); }
  finally { shared.close(); }
  const local = custody(env, { readOnly: true, createIfMissing: false });
  if (!local) throw new Error('SNAPSHOT_NATIVE_CREDENTIAL_BOOTSTRAP_MISSING');
  try {
    for (const table of ['device_identities', 'device_auth_tokens', 'gateway_origin_device_tokens', 'native_exec_socket_credentials']) {
      if (local.database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count !== 0) throw new Error('SNAPSHOT_CLIENT_IDENTITY_RETAINED');
    }
    if (local.database.prepare("SELECT count(*) AS count FROM client_credential_migration WHERE version=1 AND phase='complete'").get().count !== 1) throw new Error('SNAPSHOT_NATIVE_CREDENTIAL_BOOTSTRAP_INCOMPLETE');
  } finally { local.close(); }
  for (const entry of [path.join(clientDir, 'credentials.sqlite'), clientDir]) {
    const fd = fs.openSync(entry, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { skipped: false, nativeCredentialAdmission: true, retainedIdentities: 0, retainedTokens: 0, sharedSchemaVersion: contentVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [stateDir, packageDir] = process.argv.slice(2);
  if (!stateDir || !packageDir) throw new Error('Usage: bootstrap-snapshot-client-credentials.mjs STATE_DIR OPENCLAW_PACKAGE_DIR');
  console.log(JSON.stringify(await bootstrapSnapshotClientCredentials(path.resolve(stateDir), path.resolve(packageDir))));
}
