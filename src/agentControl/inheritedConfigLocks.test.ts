import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

it("refuses unheld same-inode inherited descriptors while another writer holds custody; accepts genuinely held nested descriptions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inherited-config-"));
  const config = path.join(dir, "config.json"); await fs.writeFile(config, '{}');
  const model = await fs.open(config + '.model-fence.lock', 'a+');
  const owner = await fs.open(config + '.owner-write.lock', 'a+');
  const held = spawn('flock', ['-x', config + '.model-fence.lock', 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => held.once('exit', resolve));
  const execute = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import {writeOwnerFencedConfig,withOwnerFenceLock} from './src/agentControl/ownerFence.ts'; await withOwnerFenceLock(process.argv[1], () => writeOwnerFencedConfig(process.argv[1], '{"written":true}', undefined, {expectedConfigText:'{}',validate:async()=>{await import('node:fs/promises').then(fs=>fs.writeFile(process.argv[1]+'.side-effect','yes'))}}));`, config], { env: { ...process.env, GOLEM_CONFIG_MODEL_FD: '3', GOLEM_CONFIG_OWNER_FD: '4' }, stdio: ['ignore', 'pipe', 'pipe', model.fd, owner.fd] });
  try {
    await new Promise<void>((resolve, reject) => { held.once('error', reject); held.stdout.once('data', () => resolve()); });
    const refused = execute(); expect(refused.status).not.toBe(0); expect(String(refused.stderr)).toContain('INHERITED_CONFIG_LOCK_NOT_HELD');
    expect(await fs.readFile(config, 'utf8')).toBe('{}'); await expect(fs.access(config + '.side-effect')).rejects.toThrow();
    held.stdin.end(); await ended;
    // Still refuse an unlocked descriptor, even with no other writer.
    expect(execute().status).not.toBe(0);
    for (const fd of [model.fd, owner.fd]) expect(spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status).toBe(0);
    const applied = execute(); expect(String(applied.stderr)).toBe(''); expect(applied.status).toBe(0);
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ written: true });
    expect(await fs.readFile(config + '.side-effect', 'utf8')).toBe('yes');
  } finally { held.stdin.end(); await model.close(); await owner.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
