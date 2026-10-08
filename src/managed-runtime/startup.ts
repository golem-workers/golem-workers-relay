import { execFileSync } from "node:child_process";
import { normalizeManagedConfigOnDisk, withManagedRuntimePolicy } from "./runtime-policy.js";

type StartupLogger = { error: (fields: { err: unknown; phase: string }, message: string) => void };

/** Runtime convergence is not a prerequisite for the relay control plane.
 * Keep mutation/preflight checks fail-closed, but permit management/auth repair
 * when the persisted configuration or Gateway is not ready to serve a model.
 */
export async function convergeManagedRuntimeAtStartup(
  configPath: string,
  logger: StartupLogger,
  restartGateway: () => void | Promise<void> = () => {
    execFileSync("systemctl", ["--user", "restart", "openclaw-gateway.service"], {
      env: { ...process.env, HOME: "/root", XDG_RUNTIME_DIR: "/run/user/0" },
      stdio: "pipe",
      timeout: 30_000,
    });
  },
): Promise<"unchanged" | "restarted" | "deferred"> {
  let changed: boolean;
  try {
    changed = await withManagedRuntimePolicy(configPath, undefined,
      () => normalizeManagedConfigOnDisk(configPath), { allowMissingAuth: true });
  } catch (err) {
    logger.error({ err, phase: "normalize" }, "Managed runtime convergence deferred; relay control plane remains available");
    return "deferred";
  }
  if (!changed) return "unchanged";
  try {
    await restartGateway();
    return "restarted";
  } catch (err) {
    logger.error({ err, phase: "restart" }, "Gateway restart failed after runtime convergence; relay control plane remains available");
    return "deferred";
  }
}
