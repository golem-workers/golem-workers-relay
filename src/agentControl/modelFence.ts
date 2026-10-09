import { verifyInheritedConfigLocks } from "./inheritedConfigLocks.js";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const lockScope = new AsyncLocalStorage<{ path: string; active: boolean }>();
const selectionScope = new AsyncLocalStorage<boolean>();
export function withAuthorizedModelSelection<T>(operation: () => Promise<T>): Promise<T> { return selectionScope.run(true, operation); }
export function isAuthorizedModelSelection(): boolean { return selectionScope.getStore() === true; }
export function modelFenceBase(configPath: string): string {
  return configPath === "/root/.openclaw/openclaw.json" ? "/var/lib/golem-workers/owner-fence/openclaw.json" : configPath;
}
/** Kernel lock lifetime follows the owning descriptor. Config writers use model -> owner order. */
export async function withModelFenceLock<T>(configPath: string, work: () => Promise<T>, waitSeconds = 0): Promise<T> {
  const key = path.resolve(configPath);
  const inherited = verifyInheritedConfigLocks(modelFenceBase(configPath));
  if (lockScope.getStore()?.active && lockScope.getStore()?.path === key) return work();
  if (inherited) return work();
  await fs.mkdir(path.dirname(modelFenceBase(configPath)), { recursive: true });
  const handle = await fs.open(modelFenceBase(configPath) + ".model-fence.lock", "a+", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", waitSeconds ? ["-w", String(waitSeconds), "3"] : ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("MODEL_FENCE_BUSY")));
    });
    const scope = { path: key, active: true };
    try { return await lockScope.run(scope, work); } finally { scope.active = false; }
  } finally { await handle.close(); }
}

/** Detached background work must not borrow the completed request's descriptor. */
export function withIndependentModelFenceLock<T>(configPath: string, work: () => Promise<T>, waitSeconds = 0): Promise<T> {
  return lockScope.exit(() => withModelFenceLock(configPath, work, waitSeconds));
}

export type ModelFenceState = {
  revision: string;
  predecessor: string | null;
  status: "PENDING" | "APPLIED" | "UNRESOLVED" | "CANCELLED";
  model: string;
};

function parseModelFence(value: unknown): ModelFenceState {
    if (!value || typeof value !== "object") throw new Error("MODEL_FENCE_INVALID");
    const state = value as ModelFenceState;
    if (typeof state.revision !== "string" || !state.revision || typeof state.model !== "string" ||
        !(state.predecessor === null || typeof state.predecessor === "string") ||
        !["PENDING", "APPLIED", "UNRESOLVED", "CANCELLED"].includes(state.status)) throw new Error("MODEL_FENCE_INVALID");
    return state;
}

export async function readModelFence(configPath: string, migrateLegacy = true): Promise<ModelFenceState | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(modelFenceBase(configPath) + ".model-fence.json", "utf8"));
    return parseModelFence(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (modelFenceBase(configPath) !== configPath) {
        try { const legacy = parseModelFence(JSON.parse(await fs.readFile(configPath + ".model-fence.json", "utf8"))); if (migrateLegacy) await writeModelFence(configPath, legacy); return legacy; }
        catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError; }
      }
      return null;
    }
    throw error;
  }
}

/** Must be called under withModelFenceLock. Never infer ownership from elapsed time. */
export async function writeModelFence(configPath: string, state: ModelFenceState): Promise<void> {
  const target = modelFenceBase(configPath) + ".model-fence.json";
  const temporary = target + "." + randomUUID();
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await fs.rename(temporary, target);
    const directory = await fs.open((await import("node:path")).dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
