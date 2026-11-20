import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { AuthorizationReceipts } from "../push/authorizationReceipts.js";
import { executeAgentControl } from "./executeAgentControl.js";
import { configRevision } from "./ownerFence.js";
import { withModelFenceLock } from "./modelFence.js";

// Only the credential transaction is synthetic; ingress, kernel custody and
// durable receipt admission/deduplication are the production implementations.
const writer = vi.hoisted(() => vi.fn());
vi.mock("./subscriptionPoolManager.js", async importOriginal => ({
  ...await importOriginal<typeof import("./subscriptionPoolManager.js")>(),
  syncSubscriptionPool: writer,
}));
const roots: string[] = [];
const holders: ChildProcess[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) { holder.stdin?.end(); holder.kill(); }
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  writer.mockReset();
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-fence-admission-")); roots.push(root);
  const configPath = path.join(root, "config.json"); const text = "{}";
  await fs.writeFile(configPath, text);
  writer.mockResolvedValue({ revision: 2, phase: "applied", members: [] });
  const store = new AuthorizationReceipts(path.join(root, "receipts"));
  const action = { kind: "codex.auth.pool.sync" as const, revision: 2, members: [], managedRuntimeExpectedConfigRevision: configRevision(text) };
  const execute = () => executeAgentControl({ configPath, action, gateway: { request: () => Promise.reject(Error("unexpected RPC")) } });
  return { root, configPath, text, store, action, execute };
}
async function hold(configPath: string) {
  const holder = spawn("flock", ["-x", configPath + ".model-fence.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "pipe"] }); holders.push(holder);
  await new Promise<void>((resolve, reject) => { holder.once("error", reject); holder.once("exit", () => reject(Error("holder exited before ready"))); holder.stdout.once("data", () => resolve()); });
  return holder;
}
async function terminal(store: AuthorizationReceipts, operationId: string, timeout = 5000) {
  let receipt = await store.status(operationId);
  const deadline = Date.now() + timeout;
  while (receipt.state === "RUNNING" && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); receipt = await store.status(operationId); }
  expect(receipt.state).not.toBe("RUNNING"); return receipt;
}
it("keeps a contended pool Connect RUNNING and executes exactly once after custody is released", async () => {
  const f = await fixture(); const holder = await hold(f.configPath);
  await f.store.submit("saved_revision_2", f.action, f.execute);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await f.store.status("saved_revision_2")).toMatchObject({ state: "RUNNING" });
  expect(writer).not.toHaveBeenCalled();
  // Repeated HTTP dispatch while waiting must not create a second writer.
  await Promise.all(Array.from({ length: 5 }, () => f.store.submit("saved_revision_2", f.action, f.execute)));
  holder.stdin.end();
  expect(await terminal(f.store, "saved_revision_2")).toMatchObject({ state: "SUCCEEDED", result: { revision: 2, phase: "applied" } });
  expect(writer).toHaveBeenCalledOnce();
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
});
it("does not bypass config CAS when the competing writer changes configuration while waiting", async () => {
  const f = await fixture(); const holder = await hold(f.configPath);
  await f.store.submit("changed_config", f.action, f.execute);
  await new Promise(resolve => setTimeout(resolve, 100));
  await fs.writeFile(f.configPath, '{"authored":"new"}'); holder.stdin.end();
  expect(await terminal(f.store, "changed_config")).toMatchObject({ state: "UNKNOWN", code: "AUTH_OPERATION_OUTCOME_UNKNOWN:CONFIG_CONFLICT" });
  expect(writer).not.toHaveBeenCalled();
});
it("bounds persistent contention and preserves pre-writer REFUSED without stealing custody", async () => {
  const f = await fixture(); const holder = await hold(f.configPath);
  await f.store.submit("persistent", f.action, f.execute);
  expect(await terminal(f.store, "persistent", 35000)).toMatchObject({ state: "REFUSED", code: "MODEL_FENCE_BUSY" });
  expect(writer).not.toHaveBeenCalled();
  // A refused receipt is not an implicit retry after the holder releases.
  holder.stdin.end(); await f.store.submit("persistent", f.action, f.execute);
  expect(writer).not.toHaveBeenCalled();
}, 40000);
it("retains fail-fast semantics for unrelated config mutations", async () => {
  const f = await fixture(); await hold(f.configPath);
  await expect(executeAgentControl({ configPath: f.configPath, action: { kind: "config.apply", configText: "{}" }, gateway: { request: () => Promise.resolve({}) } })).rejects.toThrow("MODEL_FENCE_BUSY");
  expect(writer).not.toHaveBeenCalled();
});
it("acknowledges contended Connect over authenticated HTTP and deduplicates the saved operation", async () => {
  const { startPushServer } = await import("../push/pushServer.js");
  const f = await fixture(); const holder = await hold(f.configPath);
  const previous = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = f.root;
  const server = startPushServer({ port: 0, path: "/relay/messages", relayToken: "synthetic-admission-token", onMessage: () => Promise.resolve(), onAgentControl: f.execute });
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("missing port");
    const post = async (mode: "submit" | "status") => {
      const response = await fetch(`http://127.0.0.1:${address.port}/relay/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-admission-token" }, body: JSON.stringify({ messageId: "http_saved_2", input: { kind: "agent_control", action: mode === "submit" ? f.action : { kind: "config.read" }, durableOperation: { id: "http_saved_2", mode } } }) });
      expect(response.status).toBe(200);
      return await response.json() as { receipt: { state: string; result?: { revision: number; phase: string } } };
    };
    expect((await post("submit")).receipt.state).toBe("RUNNING");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await post("status")).receipt.state).toBe("RUNNING");
    expect(writer).not.toHaveBeenCalled();
    await post("submit"); holder.stdin.end();
    await vi.waitFor(async () => expect((await post("status")).receipt).toMatchObject({ state: "SUCCEEDED", result: { revision: 2, phase: "applied" } }));
    await post("submit"); expect(writer).toHaveBeenCalledOnce();
  } finally {
    holder.stdin.end();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous;
  }
});

it("resumes a saved pre-writer refusal once, without changing operation or membership revision", async () => {
  const f = await fixture(); const holder = await hold(f.configPath);
  await f.store.submit("existing_saved_2", f.action, () => withModelFenceLock(f.configPath, f.execute));
  const previous = await terminal(f.store, "existing_saved_2");
  expect(previous).toMatchObject({ state: "REFUSED", code: "MODEL_FENCE_BUSY" });
  if (previous.state === "NOT_FOUND") throw Error("missing saved receipt");
  await f.store.resume("existing_saved_2", f.action, previous.fingerprint, f.execute);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(await f.store.status("existing_saved_2")).toMatchObject({ state: "RUNNING", resumeCount: 1 });
  expect(writer).not.toHaveBeenCalled(); holder.stdin.end();
  expect(await terminal(f.store, "existing_saved_2")).toMatchObject({ operationId: "existing_saved_2", state: "SUCCEEDED", resumeCount: 1, result: { revision: 2 } });
  expect(writer).toHaveBeenCalledOnce();
});

// The creation route bootstrap has no credentials yet, but still shares custody
// with post-provisioning writers. Waiting must never weaken its config CAS.
it("rechecks initial-bootstrap config CAS after a competing writer releases custody", async () => {
  const f = await fixture(); const holder = await hold(f.configPath);
  const action = { kind: "model.set" as const, model: "codex/gpt-6.1-sol", fallbacks: [], subscriptionBootstrap: true as const,
    fence: { revision: "bootstrap", predecessor: null }, managedRuntimeExpectedConfigRevision: configRevision(f.text) };
  let settled = false;
  const result = executeAgentControl({ configPath: f.configPath, action, policyAuthority: "backend", gateway: { request: () => Promise.reject(Error("unexpected RPC")) } }).catch((error: unknown) => error).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(settled).toBe(false);
  await fs.writeFile(f.configPath, '{"authored":"new"}'); holder.stdin.end();
  expect(await result).toMatchObject({ code: "CONFIG_CONFLICT" });
  expect(await fs.readFile(f.configPath, "utf8")).toBe('{"authored":"new"}');
  expect(writer).not.toHaveBeenCalled();
});
it("bounds initial-bootstrap contention without changing config or stealing the model lock", async () => {
  const f = await fixture(); await hold(f.configPath);
  const action = { kind: "model.set" as const, model: "codex/gpt-6.1-sol", fallbacks: [], subscriptionBootstrap: true as const, fence: { revision: "bootstrap", predecessor: null } };
  await expect(executeAgentControl({ configPath: f.configPath, action, policyAuthority: "backend", gateway: { request: () => Promise.reject(Error("unexpected RPC")) } })).rejects.toThrow("MODEL_FENCE_BUSY");
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  expect(writer).not.toHaveBeenCalled();
}, 40000);
it("keeps ordinary model selections fail-fast while creation bootstrap has bounded admission", async () => {
  const f = await fixture(); await hold(f.configPath);
  await expect(executeAgentControl({ configPath: f.configPath, action: { kind: "model.set", model: "codex/gpt-6.1-sol", fallbacks: [] }, gateway: { request: () => Promise.resolve({}) } })).rejects.toThrow("MODEL_FENCE_BUSY");
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
});
