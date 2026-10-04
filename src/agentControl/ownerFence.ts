import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
const context = new AsyncLocalStorage<{ path: string; active: boolean }>();
export function isConfigMutationPath(file: string) { const scope = context.getStore(); return Boolean(scope?.active && scope.path === path.resolve(file)); }
export function configRevision(text: string) { return createHash("sha256").update(text).digest("hex"); }
import JSON5 from "json5";

function fenceBase(configPath: string) {
  // The production high-water mark must survive .openclaw backup restoration.
  return configPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/owner-fence/openclaw.json" : configPath;
}
export const configCommitProtocolVersion = 2;
export type OwnerFence = { revision: string; active: string[]; revoked: string[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid config object");
  return value as Record<string, unknown>;
}
export function projectOwners(text: string, fence: OwnerFence): string {
  if (!/^[0-9]+$/.test(fence.revision) || [...fence.active, ...fence.revoked].some(id => !/^[1-9][0-9]{0,19}$/.test(id))) throw new Error("Invalid owner fence");
  const config = object(JSON5.parse(text));
  const commands = config.commands === undefined ? {} : object(config.commands);
  const owners: unknown = commands.ownerAllowFrom ?? [];
  if (!Array.isArray(owners) || owners.some(owner => typeof owner !== "string")) throw new Error("Invalid owner list");
  const ownerEntries = owners as string[];
  const revoked = new Set(fence.revoked.filter(id => !fence.active.includes(id)));

  commands.ownerAllowFrom = [...new Set([...ownerEntries.filter((owner: string) => !revoked.has(owner.trim().replace(/^(telegram|tg):/i, "").trim())), ...fence.active.map(id => "telegram:" + id)])];
  config.commands = commands;
  return JSON.stringify(config, null, 2) + "\n";
}
async function atomic(file: string, text: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  const directory = await fs.open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readOwnerFence(configPath: string): Promise<OwnerFence | null> {
  try { return JSON.parse(await fs.readFile(fenceBase(configPath) + ".owner-fence.json", "utf8")) as OwnerFence; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
// Kernel flock is released on process death; no age-based lock stealing or
// persistent mkdir orphan. Holding stdin keeps only this bounded IO lock alive.
export async function withOwnerFenceLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  configPath = path.resolve(configPath);
  if (isConfigMutationPath(configPath)) return operation();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.mkdir(path.dirname(fenceBase(configPath)), { recursive: true });
  const lock = spawn("flock", ["-x", "-w", "30", fenceBase(configPath) + ".owner-write.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      lock.once("error", reject);
      lock.once("exit", () => reject(new Error("OWNER_CONFIG_LOCK_UNAVAILABLE")));
      lock.stdout.once("data", () => resolve());
    });
    const scope = { path: configPath, active: true };
    try { return await context.run(scope, operation); } finally { scope.active = false; }
  } finally { lock.stdin.end(); }
}
export async function writeOwnerFencedConfig(configPath: string, text: string, incoming?: OwnerFence, options: {
  expectedConfigText?: string | null;
  expectedRevision?: string;
  validate?: (candidate: string) => Promise<void>;
} = {}): Promise<string> {
  return withOwnerFenceLock(configPath, async () => {
    const previous = await readOwnerFence(configPath);
    if (incoming && previous && BigInt(incoming.revision) < BigInt(previous.revision)) throw new Error("STALE_OWNER_REVISION");
    if (incoming && previous && incoming.revision === previous.revision && JSON.stringify(incoming) !== JSON.stringify(previous)) throw new Error("OWNER_REVISION_CONFLICT");
    let current: string | undefined;
    try { current = await fs.readFile(configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (options.expectedRevision !== undefined && (current === undefined || configRevision(current) !== options.expectedRevision)) throw new Error("CONFIG_CONFLICT");
    if (options.expectedConfigText !== undefined && (options.expectedConfigText === null ? current !== undefined : (current === undefined || !isDeepStrictEqual(JSON5.parse(current), JSON5.parse(options.expectedConfigText))))) throw new Error("CONFIG_CONFLICT");
    const fence = incoming ?? previous;
    const projected = fence ? projectOwners(text, fence) : text;
    // Retain caller validation semantics. Owner projection itself validates the
    // narrow field; do not impose a new whole-config/media migration here.
    if (options.validate) {
      const candidate = configPath + ".candidate-" + randomUUID();
      try { await fs.writeFile(candidate, projected, { mode: 0o600, flag: "wx" }); await options.validate(candidate); }
      finally { await fs.rm(candidate, { force: true }); }
    }
    // Authority first: a crash after this point may require convergence, never
    // restore a lower authorization revision. Locks are never stolen on age.
    if (incoming) await atomic(fenceBase(configPath) + ".owner-fence.json", JSON.stringify(incoming));
    await atomic(configPath, projected);
    return configRevision(projected);
  });
}
