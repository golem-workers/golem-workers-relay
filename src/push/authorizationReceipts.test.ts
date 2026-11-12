import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationReceipts } from "./authorizationReceipts.js";
import { logger } from "../logger.js";
import { SubscriptionPoolError } from "../agentControl/openAiSubscriptionPool.js";
import { ModelFenceBusyError } from "../agentControl/modelFence.js";

describe("durable credential receipts", () => {
  let directory: string;
  let store: AuthorizationReceipts;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "auth-receipts-")); store = new AuthorizationReceipts(directory); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  async function terminal(id = "operation") {
    for (let i = 0; i < 100; i++) { const receipt = await store.status(id); if (receipt.state !== "RUNNING") return receipt; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error("receipt did not finish");
  }
  it("classifies a proven pre-writer config refusal without permitting automatic replay", async () => {
    const action = { kind: "codex.auth.pool.sync", revision: 5, members: [], managedRuntimeExpectedConfigRevision: "old" };
    const execute = vi.fn(() => Promise.reject(new SubscriptionPoolError("OPENAI_POOL_CONFIG_RUNTIME_PENDING", "private-runtime-detail")));
    await store.submit("prewriter", action, execute);
    expect(await terminal("prewriter")).toMatchObject({ state: "REFUSED", code: "OPENAI_POOL_CONFIG_RUNTIME_PENDING" });
    await store.submit("prewriter", action, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(directory, "prewriter.json"), "utf8")).not.toContain("private-runtime-detail");
  });
  it("resumes only explicit pre-writer refusal with the same credential intent and fresh dispatch fence", async () => {
    const action = { kind: "codex.auth.pool.sync", revision: 5, members: [{ accountId: "a", credentialVersion: 1 }], managedRuntimeExpectedConfigRevision: "old" };
    await store.submit("resume", action, () => Promise.reject(new SubscriptionPoolError("OPENAI_POOL_CONFIG_RUNTIME_PENDING", "private")));
    const previous = await terminal("resume");if (previous.state === "NOT_FOUND") throw Error("missing refusal");
    const execute = vi.fn(() => Promise.resolve({ kind: "codex.auth.pool.sync" as const, revision: 5, phase: "applied" as const, members: [] }));
    await expect(store.resume("resume", { ...action, revision: 6 }, previous.fingerprint, execute)).rejects.toThrow("AUTH_OPERATION_CONFLICT");
    store = new AuthorizationReceipts(directory);
    await store.resume("resume", { ...action, managedRuntimeExpectedConfigRevision: "new" }, previous.fingerprint, execute);
    expect(await terminal("resume")).toMatchObject({ state: "SUCCEEDED", resumeCount: 1, previousRefusals: ["OPENAI_POOL_CONFIG_RUNTIME_PENDING"] });
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(directory, "resume.json"), "utf8")).not.toContain("private");
  });
  it("never resumes unknown or interrupted effects, even under unchanged intent", async () => {
    const action = { kind: "codex.auth.clear" };
    await store.submit("unknown", action, () => Promise.reject(Error("failure after write")));
    const previous = await terminal("unknown");if (previous.state === "NOT_FOUND") throw Error("missing receipt");
    const execute = vi.fn(() => Promise.resolve({ kind: "codex.auth.clear" as const, applied: true as const }));
    await expect(store.resume("unknown", action, previous.fingerprint, execute)).rejects.toThrow("AUTH_OPERATION_RESUME_UNSAFE");
    expect(execute).not.toHaveBeenCalled();
  });
  it("excludes competing receipt-store instances during resume admission", async () => {
    const action = { kind: "codex.auth.clear" };
    await store.submit("race", action, () => Promise.reject(new ModelFenceBusyError()));
    const previous = await terminal("race");if (previous.state === "NOT_FOUND") throw Error("missing refusal");
    let finish!: () => void;const gate = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn(async () => { await gate; return { kind: "codex.auth.clear" as const, applied: true as const }; });
    await Promise.allSettled(Array.from({length:4}, () => new AuthorizationReceipts(directory).resume("race", action, previous.fingerprint, execute)));
    expect(execute).toHaveBeenCalledOnce();finish();
    await vi.waitFor(async () => { expect(await store.status("race")).toMatchObject({ state: "SUCCEEDED" }); });
  });
  it("acknowledges slow stop promptly, completes after caller loss, and deduplicates concurrent and terminal requests", async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn(async () => { await wait; return { kind: "codex.auth.clear" as const, applied: true }; });
    const action = { kind: "codex.auth.clear" };
    const receipts = await Promise.all(Array.from({ length: 6 }, () => store.submit("operation", action, execute)));
    expect(receipts.every(row => row.state === "RUNNING")).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await store.status("operation")).state).toBe("RUNNING");
    finish();
    expect((await terminal()).state).toBe("SUCCEEDED");
    expect((await new AuthorizationReceipts(directory).submit("operation", action, execute)).state).toBe("SUCCEEDED");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("deduplicates pool sync after a caller disconnect and receipt-store restart", async () => {
    const action = { kind: "codex.auth.pool.sync", revision: 5, members: [{ bundle: { accessToken: "private-pool-token" } }] };
    const execute = vi.fn(() => Promise.resolve({ kind: "codex.auth.pool.sync" as const, revision: 5, phase: "applied" as const, members: [] }));
    await Promise.all(Array.from({length: 34}, () => store.submit("pool_operation", action, execute)));
    expect(await terminal("pool_operation")).toMatchObject({ state: "SUCCEEDED", result: { kind: "codex.auth.pool.sync", revision: 5 } });
    await new AuthorizationReceipts(directory).submit("pool_operation", action, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(directory, "pool_operation.json"), "utf8")).not.toContain("private-pool-token");
  });
  it("does not mistake a read racing with terminal completion for a restarted operation", async () => {
    // Terminal rename precedes directory fsync and release of the executing marker.
    // Wait for the real completion event; observing SUCCEEDED alone races that cleanup.
    let completed!: () => void;
    const completion = new Promise<void>(resolve => { completed = resolve; });
    const info = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      if (args[1] === "Authorization mutation completed") completed();
    });
    try {
      await store.submit("operation", {}, () => Promise.resolve({ kind: "codex.auth.clear", applied: true }));
      await completion;
    } finally { info.mockRestore(); }
    expect((await terminal()).state).toBe("SUCCEEDED");
    // Simulate a read that captured RUNNING before the atomic terminal rename,
    // but resumed after the in-memory executing marker was released.
    const read = vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify({ operationId: "operation", state: "RUNNING" }));
    try { expect((await store.status("operation")).state).toBe("SUCCEEDED"); }
    finally { read.mockRestore(); }
  });
  it("retains interrupted mutation identity after restart without executing again", async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn(async () => { await wait; return { kind: "codex.auth.clear" as const, applied: true }; });
    await store.submit("operation", { kind: "codex.auth.clear" }, execute);
    const restarted = new AuthorizationReceipts(directory);
    expect(await restarted.status("operation")).toMatchObject({ state: "UNKNOWN", code: "AUTH_OPERATION_INTERRUPTED" });
    await restarted.submit("operation", { kind: "codex.auth.clear" }, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    finish(); await terminal();
  });
  it("distinguishes proven pre-mutation refusal from ambiguous failure", async () => {
    await store.submit("operation", {}, () => Promise.reject(new ModelFenceBusyError()));
    expect(await terminal()).toMatchObject({ state: "REFUSED", code: "MODEL_FENCE_BUSY" });
    await store.submit("ambiguous", {}, () => Promise.reject(new Error("sensitive child stderr")));
    expect(await terminal("ambiguous")).toMatchObject({ state: "UNKNOWN", code: "AUTH_OPERATION_OUTCOME_UNKNOWN" });
    expect(await fs.readFile(path.join(directory, "ambiguous.json"), "utf8")).not.toContain("sensitive");
  });
  it("rejects identity reuse with different credentials and never persists bundle secrets", async () => {
    const action = { kind: "codex.auth.sync", bundle: { accessToken: "inert-secret-sentinel" } };
    await store.submit("operation", action, () => Promise.resolve({ kind: "codex.auth.clear", applied: true }));
    await terminal();
    await expect(store.submit("operation", { ...action, bundle: { accessToken: "other" } }, vi.fn())).rejects.toThrow("AUTH_OPERATION_CONFLICT");
    const receipt = await fs.readFile(path.join(directory, "operation.json"), "utf8");
    expect(receipt).not.toContain("inert-secret-sentinel");
    expect((await fs.stat(path.join(directory, "operation.json"))).mode & 0o777).toBe(0o600);
  });
  it("reports absence and rejects path traversal", async () => {
    expect(await store.status("missing")).toMatchObject({ state: "NOT_FOUND" });
    await expect(store.status("../escape")).rejects.toThrow("AUTH_OPERATION_ID_INVALID");
  });
});
