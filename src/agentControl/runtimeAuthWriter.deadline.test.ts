import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: m.spawn }));
vi.mock("node:fs/promises", () => ({ default: {
  realpath: vi.fn(() => Promise.resolve("/synthetic/openclaw/openclaw.mjs")),
  readFile: vi.fn((file: string) => Promise.resolve(file.endsWith("package.json") ? '{"name":"openclaw"}' : '{}')),
} }));
vi.mock("node:module", () => ({ createRequire: () => ({ resolve: (value: string) => "/synthetic/" + value + ".js" }) }));
import { writeRuntimeAuth, writeRuntimeAuthPool } from "./runtimeAuthWriter.js";
let child: EventEmitter & { kill: ReturnType<typeof vi.fn>; stdin: EventEmitter & { end: ReturnType<typeof vi.fn> } };
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { kill: vi.fn(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }) });
  m.spawn.mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const operations = [
  ["single", () => writeRuntimeAuth({ configPath: "/synthetic/openclaw.json", profileId: "openai:a", credential: { access: "never-print-secret" } }), "AUTH_WRITER"],
  ["pool", () => writeRuntimeAuthPool({ configPath: "/synthetic/openclaw.json", state: {} as never, members: [] }), "AUTH_POOL_WRITER"],
] as const;
it.each(operations)("allows healthy %s cold admission beyond the old 30-second deadline", async (_name, run) => {
  const result = run();
  await vi.waitFor(() => expect(m.spawn).toHaveBeenCalledOnce());
  expect(m.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit("close", 0, null);
  await expect(result).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(child.kill).not.toHaveBeenCalled();
});
it.each(operations)("bounds %s stalled admission and refuses success after timeout", async (_name, run, prefix) => {
  const outcome = run().catch((error: unknown) => error);
  await vi.waitFor(() => expect(m.spawn).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  child.emit("close", 0, null); // A racing successful exit cannot erase timeout.
  const error = await outcome as Error & { code: string };
  expect(error.code).toBe(`${prefix}_TIMEOUT_EXIT_0_NONE`);
  expect(error.message).not.toContain("never-print-secret");
});
it("retains pool refusal stages without child stderr or credentials", async () => {
  const outcome = writeRuntimeAuthPool({ configPath: "/synthetic/openclaw.json", state: {} as never, members: [] }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(m.spawn).toHaveBeenCalledOnce());
  child.emit("close", 3, null);
  expect(await outcome).toMatchObject({ code: "AUTH_POOL_WRITER_STORE_REFUSED_EXIT_3_NONE" });
});
