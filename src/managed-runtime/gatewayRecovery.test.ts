import { expect, it, vi } from "vitest";
import { recoverGatewayConnection } from "./gatewayRecovery.js";
it("does not block ingress and recovers after exhausted Gateway startup retries", async () => {
  let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  const connect = vi.fn().mockRejectedValueOnce(new Error("auth rejected")).mockResolvedValue(undefined);
  const onError = vi.fn();
  const pending = recoverGatewayConnection({ connect, stopped: () => false, onError, wait: () => delay });
  await Promise.resolve(); await Promise.resolve();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(1);
  release(); await pending;
  expect(connect).toHaveBeenCalledTimes(2);
});
it("stops recovery without restarting after shutdown", async () => {
  let stopped = false;
  const connect = vi.fn().mockRejectedValue(new Error("offline"));
  await recoverGatewayConnection({ connect, stopped: () => stopped, onError: vi.fn(), wait: () => { stopped = true; return Promise.resolve(); } });
  expect(connect).toHaveBeenCalledTimes(1);
});
it("does not report intentional Gateway shutdown as a fault", async () => {
  let stopped = false;
  const onError = vi.fn();
  await recoverGatewayConnection({ connect: () => { stopped = true; return Promise.reject(new Error("stopped")); }, stopped: () => stopped, onError });
  expect(onError).not.toHaveBeenCalled();
});
