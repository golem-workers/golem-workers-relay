import { fileURLToPath } from "node:url";
import { runPluginCommand } from "./pluginUpdateWorker.js";
import { logger } from "../logger.js";

export function createPluginUpdateScheduler(input: {
  enabled: boolean; intervalMs: number; initialJitterMs: number; configPath: string;
}, deps: { update?: () => Promise<string>; random?: () => number } = {}) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  const update = deps.update ?? (() => runPluginCommand(process.execPath, [fileURLToPath(new URL("./pluginUpdateWorker.js", import.meta.url)), input.configPath], [], 900_000));
  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = (async () => {
        try {
          const result: unknown = JSON.parse(await update());
          logger.info({ event: "relay_channel_plugin_update", result }, "Relay-channel plugin maintenance checked");
        } catch (error) {
          const code = error instanceof Error && /^PLUGIN_[A-Z_]+$/.test(error.message) ? error.message : "PLUGIN_UPDATE_FAILED";
          logger.warn({ event: "relay_channel_plugin_update", status: "deferred", code }, "Relay-channel plugin maintenance failed or busy; inspect local receipt; retry next interval");
        }
      })().finally(() => {
        running = undefined;
        schedule(input.intervalMs + Math.floor((deps.random ?? Math.random)() * input.initialJitterMs));
      });
    }, delay);
    timer.unref();
  };
  return {
    start(): void {
      if (!stopped || !input.enabled) return;
      stopped = false;
      schedule(Math.floor((deps.random ?? Math.random)() * input.initialJitterMs));
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      // Never abandon an install midway or disconnect Gateway during activation.
      await running;
    },
  };
}
