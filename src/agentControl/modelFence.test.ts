import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readModelFence, withModelFenceLock, writeModelFence } from "./modelFence.js";

it("excludes another descriptor and releases after rejection without deleting lock identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-fence-"));
  const config = path.join(dir, "config.json");
  try {
    await expect(withModelFenceLock(config, async () => {
      await expect(withModelFenceLock(config, () => Promise.resolve(undefined))).rejects.toThrow("MODEL_FENCE_BUSY");
      throw new Error("interrupted");
    })).rejects.toThrow("interrupted");
    await withModelFenceLock(config, async () => {
      await writeModelFence(config, { revision: "r1", predecessor: null, status: "PENDING", model: "codex/example" });
    });
    expect(await readModelFence(config)).toMatchObject({ revision: "r1", status: "PENDING" });
    await fs.writeFile(config + ".model-fence.json", "{}");
    await expect(readModelFence(config)).rejects.toThrow("MODEL_FENCE_INVALID");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("releases kernel ownership on cross-process SIGKILL while retaining durable intent", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-fence-death-"));
  const config = path.join(dir, "config.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
    const fd=fs.openSync(process.argv[1]+'.model-fence.lock','a+',0o600);
    const result=spawnSync('flock',['-n','3'],{stdio:['ignore','ignore','ignore',fd]});
    if(result.status!==0) process.exit(2);
    fs.writeFileSync(process.argv[1]+'.model-fence.json',JSON.stringify({revision:'old',predecessor:null,status:'PENDING',model:'old/model'}));
    console.log('owned'); setInterval(()=>{},1000);
  `, config], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve()); child.once("error", reject);
      child.once("exit", () => reject(new Error("owner exited before readiness")));
    });
    await expect(withModelFenceLock(config, () => Promise.resolve())).rejects.toThrow("MODEL_FENCE_BUSY");
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    await withModelFenceLock(config, async () => {
      expect(await readModelFence(config)).toMatchObject({ revision: "old", status: "PENDING" });
    });
  } finally { child.kill("SIGKILL"); await fs.rm(dir, { recursive: true, force: true }); }
});

it("central ingress rejects delayed revisions and legacy writers and reconciles without success", async () => {
  const { executeAgentControl } = await import("./executeAgentControl.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-fence-ingress-"));
  const configPath = path.join(dir, "config.json");
  const revision = "11111111-1111-4111-8111-111111111111";
  const input = { configPath, gateway: { request: () => Promise.reject(new Error("unexpected gateway call")) } };
  try {
    await fs.writeFile(configPath, "{}");
    await withModelFenceLock(configPath, () => writeModelFence(configPath, { revision, predecessor: null, status: "PENDING", model: "new/model" }));
    await expect(executeAgentControl({ ...input, action: { kind: "model.set", model: "old/model", fallbacks: [], fence: { revision: "22222222-2222-4222-8222-222222222222", predecessor: null } } })).rejects.toMatchObject({ code: "MODEL_FENCE_STALE" });
    await expect(executeAgentControl({ ...input, action: { kind: "model.set", model: "old/model", fallbacks: [] } })).rejects.toMatchObject({ code: "MODEL_FENCE_REQUIRED" });
    await expect(executeAgentControl({ ...input, action: { kind: "config.apply", configText: "{}" } })).rejects.toMatchObject({ code: "MODEL_FENCE_REQUIRED" });
    await expect(executeAgentControl({ ...input, action: { kind: "modelAssignment.set", purpose: "main", primary: "old/model", fallback: null } })).rejects.toMatchObject({ code: "MODEL_FENCE_REQUIRED" });
    expect(await executeAgentControl({ ...input, action: { kind: "model.fence.reconcile", revision, predecessor: null, model: "new/model" } })).toMatchObject({ status: "UNRESOLVED" });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("tombstones undelivered intent before a late old request can execute", async () => {
  const { executeAgentControl } = await import("./executeAgentControl.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-fence-undelivered-"));
  const configPath = path.join(dir, "config.json");
  const revision = "11111111-1111-4111-8111-111111111111";
  const input = { configPath, gateway: { request: () => Promise.reject(new Error("unexpected")) } };
  try {
    await fs.writeFile(configPath, "{}");
    expect(await executeAgentControl({ ...input, action: { kind: "model.fence.reconcile", revision, predecessor: null, model: "old/model" } })).toMatchObject({ status: "CANCELLED" });
    await expect(executeAgentControl({ ...input, action: { kind: "model.set", model: "old/model", fallbacks: [], fence: { revision, predecessor: null } } })).rejects.toMatchObject({ code: "MODEL_FENCE_STALE" });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it("parses and dispatches real model.verify protocol against runtime defaults and inference", async () => {
  const { agentControlActionSchema, agentControlResultSchema } = await import("./protocol.js");
  const { executeAgentControl } = await import("./executeAgentControl.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-verify-"));
  try {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ agents: { defaults: { model: { primary: "openai/example", fallbacks: [] }, models: { "openai/example": { agentRuntime: { id: "codex" } } } } } }));
    const action = agentControlActionSchema.parse({ kind: "model.verify", model: "codex/example" });
    let calls = 0;
    const gateway = { request: (method: string, params?: unknown) => {
      expect(["sessions.patch", "sessions.delete", "chat.abort"]).toContain(method); expect(params).not.toHaveProperty("model");
      return Promise.resolve({ resolved: { modelProvider: "openai", model: "example", agentRuntime: "codex" }, entry: { modelProvider: "openai", model: "example", agentHarnessId: "codex" } });
    } };
    const statusNudgeRunner = { runChatTask: () => { calls++; return Promise.resolve({ result: { outcome: "reply" as const, reply: { runId: "test", message: "OK" } }, openclawMeta: {} }); } };
    expect(agentControlResultSchema.parse(await executeAgentControl({ configPath: path.join(dir, "config.json"), action, gateway, statusNudgeRunner }))).toMatchObject({ kind: "model.verify", verified: true });
    expect(calls).toBe(1);
    await expect(executeAgentControl({ configPath: path.join(dir, "config.json"), action: { kind: "model.verify", model: "codex/other" }, gateway, statusNudgeRunner })).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
    expect(calls).toBe(1);
    const cleanup: string[] = [];
    const apiGateway = { request: (method: string) => {
      cleanup.push(method);
      return Promise.resolve({ resolved: { modelProvider: "openai", model: "example" }, entry: { modelProvider: "openai", model: "example" } });
    } };
    await expect(executeAgentControl({ configPath: path.join(dir, "config.json"), action, gateway: apiGateway, statusNudgeRunner })).rejects.toMatchObject({ code: "MODEL_VERIFY_MISMATCH" });
    expect(calls).toBe(1);
    expect(cleanup).toEqual(["sessions.patch", "chat.abort", "sessions.delete"]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
