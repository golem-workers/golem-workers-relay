import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { modelFenceBase } from "../agentControl/modelFence.js";
import { ensureRelayChannelPluginUpToDate } from "./ensurePluginUpToDate.js";

/** All direct children inherit the kernel locks. Parent/Relay death cannot
 * release mutation custody while the installer child is still alive. */
export function runPluginCommand(command: string, args: string[], fds: number[] = [], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", ...fds], detached: true });
    let stdout = "", stderr = "", size = 0, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate the whole CLI/npm group, not just a launcher holding locks.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
    }, timeoutMs);
    child.stdout!.on("data", (data: Buffer) => { size += data.length; if (size <= 2 * 1024 * 1024) stdout += data.toString(); });
    // Drain stderr but never return/log CLI output containing config or secrets.
    child.stderr!.on("data", (data: Buffer) => { if (stderr.length < 1024) stderr += data.toString(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("PLUGIN_COMMAND_SPAWN_FAILED")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut || code !== 0 || size > 2 * 1024 * 1024) reject(new Error(timedOut ? "PLUGIN_COMMAND_TIMEOUT" : /^PLUGIN_[A-Z_]+$/.test(stderr.trim()) ? stderr.trim() : "PLUGIN_COMMAND_FAILED"));
      else resolve(stdout);
    });
  });
}
export async function runPluginUpdateWorker(configPath: string): Promise<void> {
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  const base = modelFenceBase(configPath);
  const installLock = configPath === "/root/.openclaw/openclaw.json"
    ? "/var/lib/golem-workers/runtime-install/install.lock" : configPath + ".install.lock";
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  try {
    for (const file of [installLock, base + ".model-fence.lock", base + ".owner-write.lock"]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const handle = await fs.open(file, "a+", 0o600);
      handles.push(handle);
      await runPluginCommand("flock", ["-n", "3"], [handle.fd]);
    }
    const result = await ensureRelayChannelPluginUpToDate({ openclawConfigPath: configPath }, {
      exec: (command, args, timeout) => runPluginCommand(command, args, handles.map(h => h.fd), timeout),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath || !path.isAbsolute(configPath)) throw new Error("PLUGIN_CONFIG_PATH_REQUIRED");
  void runPluginUpdateWorker(configPath).catch(error => {
    // Only our bounded codes, never arbitrary subprocess error/output/env.
    const code = error instanceof Error && /^PLUGIN_[A-Z_]+$/.test(error.message) ? error.message : "PLUGIN_UPDATE_FAILED";
    process.stderr.write(code + "\n"); process.exitCode = 1;
  });
}
