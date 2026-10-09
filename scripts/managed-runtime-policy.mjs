#!/usr/bin/env node
// Reproducible, network-free vendoring. Canonical source is in the backend repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonical = path.join(root, 'packages/managed-runtime-policy/src/policy.ts');
const sourcePath = fs.existsSync(canonical) ? canonical : path.join(root, 'vendor/managed-runtime-policy/policy.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const testSource = fs.readFileSync(path.join(path.dirname(sourcePath), 'policy.contract.test.ts'), 'utf8');
const testOutput = '// GENERATED canonical contract tests. DO NOT EDIT.\n' + testSource;
const testTarget = path.join(root, 'src/managed-runtime/policy.contract.test.ts');
const sha256 = crypto.createHash('sha256').update(source).digest('hex');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replace(/export (?=(?:async )?function )/g, '');
const cli = javascript + `
const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");
const managed = createManagedRuntimePolicy();
const configPath = process.argv[2] || "/root/.openclaw/openclaw.json";
const policyPath = process.argv[3] || "/var/lib/golem-workers/managed-runtime-policy.json";
async function run() {
const primaryConfigPath = process.env.GOLEM_MANAGED_RESTORE_TARGET || configPath.replace(/\\.managed-restore-candidate$/, "");
const fenceBase = primaryConfigPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/owner-fence/openclaw.json" : primaryConfigPath;
fs.mkdirSync(path.dirname(fenceBase), { recursive: true });
const { spawn, spawnSync } = process.getBuiltinModule("node:child_process");
const inheritedModel = process.env.GOLEM_CONFIG_MODEL_FD;
const inheritedOwner = process.env.GOLEM_CONFIG_OWNER_FD;
if (inheritedModel !== undefined || inheritedOwner !== undefined) {
 const descriptors = [Number(inheritedModel), Number(inheritedOwner)];
 if (descriptors.some(fd => !Number.isInteger(fd) || fd < 3) || descriptors[0] === descriptors[1]) throw new Error("CONFIG_LOCK_DESCRIPTOR_INVALID");
 for (const [index, suffix] of [".model-fence.lock", ".owner-write.lock"].entries()) {
  const fd = descriptors[index], held = fs.fstatSync(fd), expected = fs.statSync(fenceBase + suffix);
  if (held.dev !== expected.dev || held.ino !== expected.ino) throw new Error("CONFIG_LOCK_IDENTITY_MISMATCH");
  if (!/FLOCK\\s+ADVISORY\\s+WRITE\\s/.test(fs.readFileSync("/proc/self/fdinfo/" + fd, "utf8"))) throw new Error("INHERITED_CONFIG_LOCK_NOT_HELD");
 }
 for (const fd of ["3", "4"]) if (spawnSync("flock", ["-n", fd], { stdio: ["ignore", "ignore", "ignore", ...descriptors] }).status !== 0) throw new Error("INHERITED_CONFIG_LOCK_NOT_HELD");
}
const modelLock = inheritedModel ? null : spawn("flock", ["-x", "-w", "30", fenceBase + ".model-fence.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
if (modelLock) await new Promise((resolve, reject) => { modelLock.once("error", reject); modelLock.once("exit", () => reject(new Error("MODEL_FENCE_BUSY"))); modelLock.stdout.once("data", resolve); });
const lock = inheritedOwner ? null : spawn("flock", ["-x", "-w", "30", fenceBase + ".owner-write.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
try {
if (lock) await new Promise((resolve, reject) => { lock.once("error", reject); lock.once("exit", () => reject(new Error("OWNER_CONFIG_LOCK_UNAVAILABLE"))); lock.stdout.once("data", resolve); });
for (const [descriptor, file] of [[inheritedModel, fenceBase + ".model-fence.lock"], [inheritedOwner, fenceBase + ".owner-write.lock"]]) {
  if (descriptor) { const held = fs.fstatSync(Number(descriptor)), expected = fs.statSync(file); if (held.dev !== expected.dev || held.ino !== expected.ino) throw new Error("CONFIG_LOCK_IDENTITY_MISMATCH"); }
}
const current = fs.existsSync(policyPath) ? managed.parsePolicy(JSON.parse(fs.readFileSync(policyPath, "utf8"))) : managed.defaultPolicy;
const incoming = process.env.GOLEM_MANAGED_RUNTIME_POLICY_JSON ? managed.parsePolicy(JSON.parse(process.env.GOLEM_MANAGED_RUNTIME_POLICY_JSON)) : current;
// The backend's privileged target-scoped writer supplies incoming authority.
// Retain an existing sidecar's server binding and monotonic revisions without
// introducing a mandatory identity environment variable on existing agents.
const policy = managed.acceptPolicy(current, incoming);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const modelFence = fenceBase + ".model-fence.json";
if (primaryConfigPath === "/root/.openclaw/openclaw.json" && !fs.existsSync(modelFence) && fs.existsSync(primaryConfigPath + ".model-fence.json")) {
  const modulePath = "/root/golem-workers-relay/dist/agentControl/modelFence.js";
  if (!fs.existsSync(modulePath)) throw new Error("MODEL_FENCE_MODULE_REQUIRED");
  const { readModelFence } = await import(modulePath);
  await readModelFence(primaryConfigPath);
}
if (fs.existsSync(modelFence) || fs.existsSync(primaryConfigPath + ".model-fence.json")) {
  const baseline = JSON.parse(fs.readFileSync(primaryConfigPath, "utf8"));
  if (!process.getBuiltinModule("node:util").isDeepStrictEqual(managed.protectedRoute(baseline), managed.protectedRoute(config))) throw new Error("MODEL_FENCE_REQUIRED");
}
managed.normalizeConfig(config, policy, { ...(managed.needsAuthContext(config, policy) ? readOfflineRuntimeAuth(configPath) : {}), env: process.env, allowMissingAuth: current.chatHarness === "codex" && JSON.stringify(current) === JSON.stringify(policy) });
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".managed-" + process.pid;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
// Authority first. A crash may require convergence; never allow a stale rollback.
let text = JSON.stringify(config, null, 2) + "\\n";
const ownerFencePath = fenceBase + ".owner-fence.json";
if (fs.existsSync(ownerFencePath)) {
  const modulePath = "/root/golem-workers-relay/dist/agentControl/ownerFence.js";
  if (!fs.existsSync(modulePath)) throw new Error("OWNER_FENCE_MODULE_REQUIRED");
  const { projectOwners } = await import(modulePath);
  text = projectOwners(text, JSON.parse(fs.readFileSync(ownerFencePath, "utf8")));
}
const candidate = configPath + ".managed-validate-" + process.pid;
try {
  fs.writeFileSync(candidate, text, { mode: 0o600, flag: "wx" });
  const validation = process.getBuiltinModule("node:child_process").spawnSync("openclaw", ["config", "validate", "--json"], { env: { ...process.env, OPENCLAW_CONFIG_PATH: candidate }, encoding: "utf8" });
  if (validation.error || validation.status !== 0) throw new Error("OPENCLAW_CONFIG_INVALID");
} finally { fs.rmSync(candidate, { force: true }); }
atomic(policyPath, JSON.stringify(policy) + "\\n");
atomic(configPath, text);
} finally { lock?.stdin.end(); modelLock?.stdin.end(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
`;
const output = '// GENERATED by scripts/managed-runtime-policy.mjs. DO NOT EDIT.\n' + source + '\nexport const MANAGED_RUNTIME_FACTORY_SOURCE = ' + JSON.stringify(javascript) + ';\nexport const MANAGED_RUNTIME_SOURCE_SHA256 = ' + JSON.stringify(sha256) + ';\nexport const MANAGED_RUNTIME_CLI_SOURCE = ' + JSON.stringify(cli) + ';\n';
const target = path.join(root, 'src/managed-runtime/policy.generated.ts');
const manifestPath = path.join(root, fs.existsSync(canonical) ? 'packages/managed-runtime-policy/manifest.json' : 'vendor/managed-runtime-policy/manifest.json');
const cliPath = path.join(root, 'scripts/managed-runtime-normalize.mjs');
const lockPath = path.join(root, 'managed-runtime-policy.lock.json');
const manifest = { schemaVersion: 1, canonicalRepository: 'golem-workers/golem-workers-backend', canonicalPath: 'packages/managed-runtime-policy/src/policy.ts', sha256 };
// Relay cannot repin by regenerating its vendor. Only backend distribution updates the lock.
if (!fs.existsSync(canonical) && fs.readFileSync(lockPath, 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') throw new Error('Managed runtime canonical release pin mismatch; sync from backend, never repin locally');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(lockPath, 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') throw new Error('Managed runtime release pin drift');
  if (fs.readFileSync(testTarget, 'utf8') !== testOutput || fs.readFileSync(target, 'utf8') !== output || fs.readFileSync(cliPath, 'utf8') !== cli || fs.readFileSync(manifestPath, 'utf8') !== JSON.stringify(manifest, null, 2) + '\n') throw new Error('Managed runtime generated consumer/source manifest drift. Regenerate from canonical source.');
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, output); fs.writeFileSync(testTarget, testOutput); fs.writeFileSync(cliPath, cli);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (fs.existsSync(canonical)) fs.writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + '\n');
}
const syncIndex = process.argv.indexOf('--sync-relay');
if (syncIndex >= 0) {
  if (!fs.existsSync(canonical)) throw new Error('Only the backend canonical repository may distribute policy');
  const relay = path.resolve(process.argv[syncIndex + 1]);
  fs.writeFileSync(path.join(relay, 'managed-runtime-policy.lock.json'), JSON.stringify(manifest, null, 2) + '\n');
  const vendor = path.join(relay, 'vendor/managed-runtime-policy'); fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(path.join(vendor, 'policy.ts'), source);
  fs.writeFileSync(path.join(vendor, 'policy.contract.test.ts'), testSource);
  fs.writeFileSync(path.join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.copyFileSync(fileURLToPath(import.meta.url), path.join(relay, 'scripts/managed-runtime-policy.mjs'));
  fs.mkdirSync(path.join(relay, 'src/managed-runtime'), { recursive: true });
  fs.writeFileSync(path.join(relay, 'src/managed-runtime/policy.generated.ts'), output);
  fs.writeFileSync(path.join(relay, 'src/managed-runtime/policy.contract.test.ts'), testOutput);
  fs.writeFileSync(path.join(relay, 'scripts/managed-runtime-normalize.mjs'), cli);
}
const upstreamIndex = process.argv.indexOf('--verify-upstream');
if (upstreamIndex >= 0 && fs.readFileSync(path.resolve(process.argv[upstreamIndex + 1]), 'utf8') !== source) throw new Error('Vendored policy differs from canonical release source');
console.log('Managed runtime canonical SHA256: ' + sha256);
