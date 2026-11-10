import { afterEach, expect, it, vi } from "vitest";
import { createPluginUpdateScheduler } from "./pluginUpdateScheduler.js";
afterEach(() => vi.useRealTimers());
const settings = { enabled: true, intervalMs: 3_600_000, initialJitterMs: 300_000, configPath: "/tmp/unused.json" };
it("jitters startup, does not block startup, and serializes periodic checks", async () => {
  vi.useFakeTimers(); let done!: (value: string) => void;
  const update = vi.fn(() => new Promise<string>(resolve => { done = resolve; }));
  const updater = createPluginUpdateScheduler(settings, { update, random: () => 0.5 });
  updater.start(); updater.start(); expect(update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150_000); expect(update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(8_000_000); expect(update).toHaveBeenCalledTimes(1);
  done('{"status":"unchanged"}'); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3_750_000); expect(update).toHaveBeenCalledTimes(2);
  const stopped = updater.stop(); done('{"status":"unchanged"}'); await stopped;
  await vi.advanceTimersByTimeAsync(8_000_000); expect(update).toHaveBeenCalledTimes(2);
});
it("is disabled when opted out and does not poll after stop", async () => {
  vi.useFakeTimers(); const update = vi.fn();
  const updater = createPluginUpdateScheduler({ ...settings, enabled: false }, { update });
  updater.start(); await vi.advanceTimersByTimeAsync(8_000_000); await updater.stop(); expect(update).not.toHaveBeenCalled();
});
it("continues at the next interval after a failure", async () => {
  vi.useFakeTimers(); const update = vi.fn().mockRejectedValueOnce(new Error("secret never logged")).mockResolvedValue('{"status":"unchanged"}');
  const updater = createPluginUpdateScheduler({ ...settings, initialJitterMs: 0 }, { update });
  updater.start(); await vi.advanceTimersByTimeAsync(0); expect(update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(settings.intervalMs); expect(update).toHaveBeenCalledTimes(2); await updater.stop();
});
