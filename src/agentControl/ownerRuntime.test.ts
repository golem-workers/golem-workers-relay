import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readOwnerRuntime } from "./ownerRuntime.js";
let directory: string;
let configPath: string;
const fence = { revision: "2", active: ["123"], revoked: ["456"] };
const config = { commands: { ownerAllowFrom: ["telegram:123"] } };
let response: Record<string, unknown>;
let channels: Record<string, unknown>;
const gateway = { request: vi.fn((method: string) => Promise.resolve(method === "config.get" ? response : channels)) };
beforeEach(async () => {
 directory = await fs.mkdtemp(path.join(os.tmpdir(), "owner-runtime-")); configPath = path.join(directory, "openclaw.json");
 await fs.writeFile(configPath, JSON.stringify(config));
 await fs.writeFile(configPath + ".owner-fence.json", JSON.stringify(fence));
 response = { path: configPath, valid: true, config, configRevisionHash: "current", appliedConfigHash: "current" };
 channels = { statusIssues: [] }; gateway.request.mockClear();
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
it("binds exact runtime application to enrolled authority, without restarts", async () => {
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "applied", enrolledFence: fence });
 expect(gateway.request.mock.calls.map(call => call[0])).toEqual(["config.get", "channels.status", "config.get"]);
});
it.each([
 { appliedConfigHash: "old" }, { appliedConfigHash: null }, { configRevisionHash: null }, { valid: false },
 { config: { commands: { ownerAllowFrom: ["telegram:456"] } } }, { path: "/different/config.json" },
])("matching disk is pending when runtime differs: %j", async override => {
 Object.assign(response, override);
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "pending" });
});
it("rejects old runtime without application capability", async () => {
 delete response.appliedConfigHash;
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "unsupported" });
});
it("does not accept deferred channel reload", async () => {
 channels.statusIssues = [{ kind: "runtime", message: "reload deferred" }];
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "pending" });
});
it("missing channel receipt and unavailable gateway fail closed", async () => {
 channels = {};
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "unsupported" });
 gateway.request.mockRejectedValueOnce(new Error("offline"));
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "unavailable" });
});
it("no-op disk matching is not enrollment", async () => {
 await fs.rm(configPath + ".owner-fence.json");
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "pending", enrolledFence: null });
 expect(gateway.request).not.toHaveBeenCalled();
});

it("rejects runtime supersession across channel observation", async () => {
 gateway.request.mockResolvedValueOnce(response).mockResolvedValueOnce(channels).mockResolvedValueOnce({ ...response, appliedConfigHash: "newer" });
 expect(await readOwnerRuntime(configPath, gateway)).toMatchObject({ state: "pending" });
});
it("bounds a gateway connection wait and releases the commit gate", async () => {
 vi.useFakeTimers();
 try {
  gateway.request.mockReturnValueOnce(new Promise(() => {}));
  const pending = readOwnerRuntime(configPath, gateway);
  await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({ state: "unavailable" });
  await expect(fs.stat(configPath + ".owner-write-lock")).rejects.toMatchObject({ code: "ENOENT" });
 } finally { vi.useRealTimers(); }
});

