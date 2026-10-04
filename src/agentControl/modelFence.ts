import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Kernel lock lifetime follows the owning descriptor, not an expiring directory. */
export async function withModelFenceLock<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const handle = await fs.open(configPath + ".model-fence.lock", "a+", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", handle.fd] });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("MODEL_FENCE_BUSY")));
    });
    return await work();
  } finally { await handle.close(); }
}

export type ModelFenceState = {
  revision: string;
  predecessor: string | null;
  status: "PENDING" | "APPLIED" | "UNRESOLVED" | "CANCELLED";
  model: string;
};

export async function readModelFence(configPath: string): Promise<ModelFenceState | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(configPath + ".model-fence.json", "utf8"));
    if (!value || typeof value !== "object") throw new Error("MODEL_FENCE_INVALID");
    const state = value as ModelFenceState;
    if (typeof state.revision !== "string" || !state.revision || typeof state.model !== "string" ||
        !(state.predecessor === null || typeof state.predecessor === "string") ||
        !["PENDING", "APPLIED", "UNRESOLVED", "CANCELLED"].includes(state.status)) throw new Error("MODEL_FENCE_INVALID");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Must be called under withModelFenceLock. Never infer ownership from elapsed time. */
export async function writeModelFence(configPath: string, state: ModelFenceState): Promise<void> {
  const target = configPath + ".model-fence.json";
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
