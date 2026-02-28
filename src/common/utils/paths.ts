import os from "node:os";
import path from "node:path";

export function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".openclaw");
}

export function resolveOpenclawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveOpenclawStateDir(env), "openclaw.json");
}
