import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeAgentControl } from "../agentControl/executeAgentControl.js";
import type { AgentControlAction } from "../agentControl/protocol.js";
import { startPushServer } from "../push/pushServer.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "./policy.generated.js";
import { managedRuntime, normalizeManagedConfigOnDisk, policyFile, withManagedRuntimePolicy } from "./runtime-policy.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it("authenticates legacy relay Harness preflight/save, preserves routes, and reloads without identity env", async () => {
  vi.stubEnv("RELAY_SERVER_ID", undefined);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-relay-harness-")); directories.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  const original = {
    agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] }, models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } }, timeoutSeconds: 600 } },
    models: { providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture-key" } } },
    tools: { deny: ["sessions_spawn", "sessions_send"] },
  };
  const originalText = JSON.stringify(original);
  await fs.writeFile(configPath, originalText);
  const gateway = { request: vi.fn(() => Promise.resolve({})) };
  const token = "legacy-agent-token-fixture";
  const onAgentControl = vi.fn(async (message: Parameters<NonNullable<Parameters<typeof startPushServer>[0]["onAgentControl"]>>[0]) => {
    if (message.input.kind !== "agent_control") throw new Error("agent_control expected");
    return executeAgentControl({ action: message.input.action, configPath, gateway, policyAuthority: "backend" });
  });
  const server = startPushServer({ port: 0, path: "/relay/messages", relayToken: token, onMessage: async () => {}, onAgentControl });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.once("listening", resolve); });
  const port = (server.address() as { port: number }).port;
  let sequence = 0;
  const push = (action: AgentControlAction, suppliedToken = token) => fetch(`http://127.0.0.1:${port}/relay/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${suppliedToken}` },
    body: JSON.stringify({ messageId: `legacy-harness-${++sequence}`, input: { kind: "agent_control", action } }),
  });
  try {
    const target = managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId: "agent-a", revision: 1, harnessOverride: "codex" });
    const authority = { managedRuntimePolicy: target, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
    const action = { kind: "managedRuntime.preflight" as const, ...authority };
    const unauthorized = await push(action, "another-agent-token-fixture");
    expect(unauthorized.status).toBe(401); await unauthorized.text();
    expect(onAgentControl).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, "utf8")).toBe(originalText);
    await expect(fs.access(policyFile(configPath))).rejects.toMatchObject({ code: "ENOENT" });

    const proofResponse = await push(action);
    expect(proofResponse.status).toBe(200);
    const proof = await proofResponse.json() as { result: { compatible: boolean; configRevision: string } };
    expect(proof.result.compatible).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(originalText);
    await expect(fs.access(policyFile(configPath))).rejects.toMatchObject({ code: "ENOENT" });
    const applied = await push({ kind: "config.apply", ...authority, configText: originalText, expectedRevision: proof.result.configRevision, managedRuntimeExpectedConfigRevision: proof.result.configRevision });
    expect(applied.status).toBe(200); await applied.text();
    expect(JSON.parse(await fs.readFile(policyFile(configPath), "utf8"))).toEqual(target);
    const codexConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(managedRuntime.protectedRoute(codexConfig)).toEqual(managedRuntime.protectedRoute(original));
    expect(codexConfig).toMatchObject({ agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } }, tools: original.tools });

    // Restart/restore uses committed authority, even if an obsolete env key survived.
    vi.stubEnv("RELAY_SERVER_ID", "obsolete-other-agent");
    await fs.writeFile(configPath, originalText);
    await withManagedRuntimePolicy(configPath, undefined, () => normalizeManagedConfigOnDisk(configPath));
    expect(await fs.readFile(configPath, "utf8")).toContain('"codex"');
    expect(JSON.parse(await fs.readFile(policyFile(configPath), "utf8"))).toEqual(target);

    const native = managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId: "agent-a", revision: 2, harnessOverride: "openclaw" });
    const nextAuthority = { managedRuntimePolicy: native, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
    const nextProofResponse = await push({ kind: "managedRuntime.preflight", ...nextAuthority });
    expect(nextProofResponse.status).toBe(200);
    const nextProof = await nextProofResponse.json() as { result: { configRevision: string } };
    const nativeApplied = await push({ kind: "config.apply", ...nextAuthority, configText: originalText, expectedRevision: nextProof.result.configRevision, managedRuntimeExpectedConfigRevision: nextProof.result.configRevision });
    expect(nativeApplied.status).toBe(200); await nativeApplied.text();
    const committedText = await fs.readFile(configPath, "utf8");
    expect(JSON.parse(await fs.readFile(policyFile(configPath), "utf8"))).toEqual(native);
    expect(committedText).toContain('"openclaw"');
    const stale = await push(action);
    expect(stale.status).toBe(500); expect(await stale.json()).toMatchObject({ code: "PUSH_SERVER_ERROR" });
    expect(await fs.readFile(configPath, "utf8")).toBe(committedText);
    expect(JSON.parse(await fs.readFile(policyFile(configPath), "utf8"))).toEqual(native);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
