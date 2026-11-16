import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runPluginCommand } from "./pluginUpdateWorker.js";
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-worker-")); roots.push(root);
  const configPath = path.join(root, "openclaw.json");
  await fs.writeFile(configPath, '{"plugins":{"entries":{"relay-channel":{"enabled":true}}},"agents":{"defaults":{"model":"keep"}}}');
  await fs.writeFile(path.join(root, "version"), "1.0.491");
  const cli = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const root=process.env.PLUGIN_TEST_ROOT,args=process.argv.slice(2),version=()=>fs.readFileSync(path.join(root,'version'),'utf8');
const output=value=>console.log(JSON.stringify(value));
if(path.basename(process.argv[1])==='npm') output('1.0.492');
else if(args[0]==='plugins' && args[1]==='list') output({plugins:[{id:'relay-channel',version:version(),enabled:true,trust:{installSource:'npm',installSpec:'@golemworkers/relay-channel@1.0.491'}}]});
else if(args[0]==='plugins' && args[1]==='update') {
 if(args.includes('--dry-run')) console.log('Would update');
 else {fs.writeFileSync(path.join(root,'install-started'),'yes');const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release'))){clearInterval(timer);fs.writeFileSync(path.join(root,'version'),'1.0.492');console.log('Updated');}},10);}
} else if(args[2]==='gateway.restart.preflight') output({safe:true,counts:{totalActive:0}});
else if(args[2]==='plugins.list') output({plugins:[{id:'relay-channel',version:version(),runtime:{state:'active'}}]});
else if(args[2]==='health') output({ok:true});
else process.exit(4);
`;
  for (const name of ["npm", "openclaw"]) await fs.writeFile(path.join(root, name), cli, { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./pluginUpdateWorker.ts", import.meta.url)), configPath], {
    env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, PLUGIN_TEST_ROOT: root }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  await vi.waitFor(async () => { expect(await fs.readFile(path.join(root, "install-started"), "utf8")).toBe("yes"); }, { timeout: 10_000 });
  return { root, configPath, child, exited, output: () => ({ stdout, stderr }) };
}
it("shares platform install/model/owner locks through actual CLI activation", async () => {
  const f = await fixture();
  for (const suffix of [".install.lock", ".model-fence.lock", ".owner-write.lock"]) {
    await expect(runPluginCommand("flock", ["-n", f.configPath + suffix, "true"])).rejects.toThrow();
  }
  await fs.writeFile(path.join(f.root, "release"), "yes");
  expect(await f.exited).toBe(0);
  expect(JSON.parse(f.output().stdout)).toEqual({ status: "updated", version: "1.0.492" });
  expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({ agents: { defaults: { model: "keep" } } });
  for (const suffix of [".install.lock", ".model-fence.lock", ".owner-write.lock"]) {
    await expect(runPluginCommand("flock", ["-n", f.configPath + suffix, "true"])).resolves.toBe("");
  }
}, 15_000);
it("worker death does not release install custody while installer is alive", async () => {
  const f = await fixture(); f.child.kill("SIGKILL"); await f.exited;
  await expect(runPluginCommand("flock", ["-n", f.configPath + ".install.lock", "true"])).rejects.toThrow();
  await fs.writeFile(path.join(f.root, "release"), "yes");
  await vi.waitFor(async () => {
    expect(await runPluginCommand("flock", ["-n", f.configPath + ".install.lock", "true"])).toBe("");
  }, { timeout: 5_000 });
  expect(JSON.parse(await fs.readFile(f.configPath + ".relay-channel-update.json", "utf8"))).toMatchObject({ phase: "installing", version: "1.0.492" });
}, 15_000);
