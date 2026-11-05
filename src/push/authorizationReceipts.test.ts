import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationReceipts } from "./authorizationReceipts.js";
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
