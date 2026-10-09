import { spawn } from "node:child_process";
import { executeAgentControl } from "./executeAgentControl.js";
import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeOwnerFencedConfig } from "./ownerFence.js";
import { withManagedRuntimePolicy, managedRuntime, policyFile } from "../managed-runtime/runtime-policy.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "../managed-runtime/policy.generated.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
it("rechecks scoped authority at actual owner acquisition, before caller auth/config side effects", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'runtime-custody-')); dirs.push(dir);
  const file = path.join(dir, 'config.json'); await fs.writeFile(file, '{}');
  const old = managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId: 'fixture', harnessOverride: null, revision: 1 });
  const newer = { ...old, revision: 2 }; let sideEffect = false;
  await fs.writeFile(policyFile(file), JSON.stringify(old));
  await expect(withManagedRuntimePolicy(file, old, async () => {
    await fs.writeFile(policyFile(file), JSON.stringify(newer));
    await writeOwnerFencedConfig(file, '{}', undefined, { managedRuntimePolicy: old, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256, validate: () => { sideEffect = true; return Promise.resolve(); } });
  })).rejects.toThrow('MANAGED_RUNTIME_POLICY_STALE');
  expect(sideEffect).toBe(false); expect(await fs.readFile(file, 'utf8')).toBe('{}');
});

it("read-only config diagnostics work while another process holds installation config custody without mutating or bypassing supplied authority", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'runtime-diagnostic-')); dirs.push(dir);
  const file = path.join(dir, 'config.json'); await fs.writeFile(file, '{}');
  const current = managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId: 'fixture', harnessOverride: null, revision: 3 });
  await fs.writeFile(policyFile(file), JSON.stringify(current));
  const holder = spawn('flock', ['-x', file + '.model-fence.lock', 'flock', '-x', file + '.owner-write.lock', 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => holder.once('exit', resolve));
  await new Promise<void>((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', () => resolve()); });
  try {
    const result = await executeAgentControl({ configPath: file, policyAuthority: 'backend', action: { kind: 'config.read' }, gateway: { request: () => Promise.resolve({}) } });
    expect(result).toMatchObject({ kind: 'config.read', managedRuntimePolicy: current });
    await expect(executeAgentControl({ configPath: file, policyAuthority: 'backend', action: { kind: 'config.read', managedRuntimePolicy: { ...current, revision: 4 }, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 }, gateway: { request: () => Promise.resolve({}) } })).resolves.toMatchObject({ kind: 'config.read', managedRuntimePolicy: current });
    for (const action of [
      { kind: 'config.read' as const, managedRuntimePolicy: current, managedRuntimePolicyDigest: 'obsolete' },
      { kind: 'config.read' as const, managedRuntimePolicy: { ...current, serverId: 'foreign' }, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 },
    ]) await expect(executeAgentControl({ configPath: file, policyAuthority: 'backend', action, gateway: { request: () => Promise.resolve({}) } })).rejects.toThrow();

    expect(JSON.parse(await fs.readFile(policyFile(file), 'utf8'))).toEqual(current);
    await expect(writeOwnerFencedConfig(file, '{"bad":true}')).rejects.toThrow('MODEL_FENCE_BUSY');
    expect(await fs.readFile(file, 'utf8')).toBe('{}');
  } finally { holder.stdin.end(); await ended; }
});
