import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it.each(["single", "pool"] as const)("keeps model and owner kernel custody with an orphan %s auth writer after Relay death", async variant => {
  const root = await mkdtemp(path.join(os.tmpdir(), "auth-writer-custody-"));
  let parent: ChildProcess | undefined;
  let writerPid: number | undefined;
  const marker = path.join(root, "writer-started"), release = path.join(root, "release");
  try {
    const pkg = path.join(root, "sdk"), bin = path.join(root, "bin"), configPath = path.join(root, "openclaw.json");
    await mkdir(pkg); await mkdir(bin);
    await writeFile(configPath, "{}");
    await writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/provider-auth": "./provider-auth.mjs", "./plugin-sdk/session-store-runtime": "./provider-auth.mjs", "./plugin-sdk/runtime-config-snapshot": "./provider-auth.mjs", "./plugin-sdk/agent-scope-runtime": "./provider-auth.mjs" } }));
    await writeFile(path.join(pkg, "openclaw.mjs"), "");
    await symlink(path.join(pkg, "openclaw.mjs"), path.join(bin, "openclaw"));
    // Only the SDK callback is synthetic; parent death and kernel locks are real.
    await writeFile(path.join(pkg, "provider-auth.mjs"), `import fs from 'node:fs/promises';export const listSessionEntries=()=>[],patchSessionEntry=async()=>{},setRuntimeConfigSnapshot=()=>{},listAgentIds=()=>[];export async function updateAuthProfileStoreWithLock(){await fs.writeFile(${JSON.stringify(marker)},String(process.pid));for(let n=0;n<100;n++){try{await fs.access(${JSON.stringify(release)});return true;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('fixture timeout');}`);
    const ownerUrl = new URL("./ownerFence.ts", import.meta.url).href, writerUrl = new URL("./runtimeAuthWriter.ts", import.meta.url).href;
    const source = `import {withOwnerFenceLock} from ${JSON.stringify(ownerUrl)};import {writeRuntimeAuth,writeRuntimeAuthPool} from ${JSON.stringify(writerUrl)};await withOwnerFenceLock(process.argv[1],()=>${variant === "pool" ? "writeRuntimeAuthPool({configPath:process.argv[1],state:{members:[],managedProfileIds:[]},members:[]})" : "writeRuntimeAuth({configPath:process.argv[1],profileId:'openai:synthetic',credential:{access:'synthetic-no-network'}})"});`;
    parent = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, configPath], { env: { PATH: bin + path.delimiter + process.env.PATH, HOME: process.env.HOME }, stdio: "ignore" });
    for (let n = 0; n < 100; n++) { try { writerPid = Number(await readFile(marker, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    expect(writerPid).toBeGreaterThan(1);
    const ended = once(parent, "exit"); parent.kill("SIGKILL"); await ended;
    await new Promise(r => setTimeout(r, 200));
    for (const suffix of [".model-fence.lock", ".owner-write.lock"]) expect(spawnSync("flock", ["-n", configPath + suffix, "true"]).status, suffix).toBe(1);
    await writeFile(release, "release");
    let released = false;
    for (let n = 0; n < 100; n++) { released = [".model-fence.lock", ".owner-write.lock"].every(suffix => spawnSync("flock", ["-n", configPath + suffix, "true"]).status === 0); if (released) break; await new Promise(r => setTimeout(r, 50)); }
    expect(released).toBe(true);
  } finally {
    parent?.kill("SIGKILL");
    if (writerPid) { try { process.kill(writerPid, "SIGKILL"); } catch { /* already exited */ } }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
