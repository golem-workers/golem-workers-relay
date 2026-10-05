import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { executeAgentControl } from "../agentControl/executeAgentControl.js";
import { agentControlActionSchema, agentControlResultSchema } from "../agentControl/protocol.js";
import { managedRuntime, policyFile, withManagedRuntimePolicy, normalizeManagedConfigOnDisk } from "./runtime-policy.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "./policy.generated.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const scoped = (serverId = "agent-a", harnessOverride: "openclaw" | "codex" | null = null, revision = 0) => managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId, harnessOverride, revision });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-policy-")); directories.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  const config = { agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] } } }, models: { providers: { openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "fixture" } } } };
  const text = JSON.stringify(config); await fs.writeFile(configPath, text);
  const gateway = { request: () => Promise.resolve({}) };
  return { dir, configPath, gateway, text };
}
it("accepts backend authority without a new identity env and rejects local or foreign policy", async () => {
  const f = await fixture();
  const action = { kind: "managedRuntime.preflight" as const, managedRuntimePolicy: scoped("agent-a", "codex", 1), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
  await expect(executeAgentControl({ ...f, action })).rejects.toThrow("Only authenticated backend");
  await expect(executeAgentControl({ ...f, action: { ...action, managedRuntimePolicyDigest: undefined }, policyAuthority: "backend" })).rejects.toThrow("Backend policy digest is required");
  await expect(executeAgentControl({ ...f, action: { ...action, managedRuntimePolicyDigest: "0".repeat(64) }, policyAuthority: "backend" })).rejects.toThrow("source digests differ");
  await expect(executeAgentControl({ ...f, action, policyAuthority: "backend" })).resolves.toMatchObject({ kind: "managedRuntime.preflight", compatible: true });
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  await expect(fs.access(policyFile(f.configPath))).rejects.toThrow();
  const current = scoped("agent-b");
  await fs.writeFile(policyFile(f.configPath), JSON.stringify(current));
  await expect(executeAgentControl({ ...f, action, policyAuthority: "backend" })).rejects.toThrow("SERVER_MISMATCH");
  await expect(executeAgentControl({ ...f, action: { kind: "config.read" } })).resolves.toMatchObject({ managedRuntimePolicy: current });
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  expect(JSON.parse(await fs.readFile(policyFile(f.configPath), "utf8"))).toEqual(current);
});
it("read returns persisted policy; preflight projects model/fallback changes without staging or writes", async () => {
  const f = await fixture(); const current = scoped(); const target = scoped("agent-a", "codex", 1);
  await fs.writeFile(policyFile(f.configPath), JSON.stringify(current));
  const input = { ...f, policyAuthority: "backend" as const };
  const authority = { managedRuntimePolicy: target, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
  const read = await executeAgentControl({ ...input, action: { kind: "config.read", ...authority } });
  expect(read).toMatchObject({ managedRuntimePolicyVersion: 2, managedRuntimePolicy: current });
  expect(agentControlResultSchema.safeParse(read).success).toBe(true);
  const result = await executeAgentControl({ ...input, action: { kind: "managedRuntime.preflight", ...authority, model: "openai/gpt-6.1-sol", fallbacks: [] } });
  expect(result).toMatchObject({ kind: "managedRuntime.preflight", compatible: true });
  await expect(executeAgentControl({ ...input, action: { kind: "managedRuntime.preflight", ...authority, fallbacks: ["anthropic/claude"] } })).rejects.toMatchObject({ code: "MANAGED_CODEX_INCOMPATIBLE" });
  await expect(executeAgentControl({ ...input, action: { kind: "managedRuntime.preflight", ...authority, codexAuthMode: "openai_login" } })).rejects.toMatchObject({ code: "MANAGED_CODEX_INCOMPATIBLE" });
  expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  expect(JSON.parse(await fs.readFile(policyFile(f.configPath), "utf8"))).toEqual(current);
  expect(await fs.readdir(f.dir)).not.toContain("auth-profiles.json");
});
it("rejects stale agent authority before preflight and preserves independent server state", async () => {
  const a = await fixture(), b = await fixture();
  await fs.writeFile(policyFile(a.configPath), JSON.stringify(scoped("agent-a", "codex", 3)));
  await fs.writeFile(policyFile(b.configPath), JSON.stringify(scoped("agent-b", "openclaw", 1)));
  await expect(executeAgentControl({ ...a, policyAuthority: "backend", action: { kind: "managedRuntime.preflight", managedRuntimePolicy: scoped("agent-a", "openclaw", 2), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 } })).rejects.toThrow("STALE");
  const read = await executeAgentControl({ ...b, action: { kind: "config.read" } });
  expect(read.managedRuntimePolicy?.chatHarness).toBe("openclaw");
});
it("wire rejects inconsistent effective choice and accepts readonly preflight", () => {
  expect(agentControlActionSchema.safeParse({ kind: "managedRuntime.preflight", managedRuntimePolicy: scoped() }).success).toBe(true);
  expect(agentControlActionSchema.safeParse({ kind: "config.read", managedRuntimePolicy: { ...scoped(), chatHarness: "codex" } }).success).toBe(false);
});
it("emitted CLI converges scoped authority without identity env and retains server/revision/schema fences", async () => {
  const f = await fixture(); const sidecar = policyFile(f.configPath);
  const bin = path.join(f.dir, "bin"); await fs.mkdir(bin);
  // Validate the candidate JSON without calling the installed Gateway or its CLI.
  await fs.writeFile(path.join(bin, "openclaw"), '#!/usr/bin/env node\nJSON.parse(require("fs").readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")); process.exit(process.env.TEST_SCHEMA_REJECTED === "1" ? 1 : 0);\n', { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  delete env.RELAY_SERVER_ID;
  delete env.GOLEM_MANAGED_RUNTIME_POLICY_JSON;
  async function runCli(extra: NodeJS.ProcessEnv = {}) {
    return new Promise<{ code: number | null; error: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/managed-runtime-normalize.mjs", f.configPath, sidecar], { env: { ...env, ...extra }, stdio: ["ignore", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", value => { error += String(value); });
      child.once("error", reject); child.once("exit", code => resolve({ code, error }));
    });
  }
  const target = scoped("agent-a", "codex", 1);
  expect((await runCli({ GOLEM_MANAGED_RUNTIME_POLICY_JSON: JSON.stringify(target) })).code).toBe(0);
  expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual(target);
  await fs.writeFile(f.configPath, f.text); // Restart/restore convergence with only protected persisted authority.
  expect((await runCli()).code).toBe(0);
  expect(await fs.readFile(f.configPath, "utf8")).toContain('"codex"');
  const before = await fs.readFile(f.configPath, "utf8");
  for (const [policy, reason] of [[scoped("agent-b", "codex", 2), "SERVER_MISMATCH"], [scoped("agent-a", null, 0), "STALE"], [managedRuntime.defaultPolicy, "DOWNGRADE"]] as const) {
    const result = await runCli({ GOLEM_MANAGED_RUNTIME_POLICY_JSON: JSON.stringify(policy) });
    expect(result.code).toBe(1); expect(result.error).toContain(reason);
    expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
    expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual(target);
  }
  const result = await runCli({ GOLEM_MANAGED_RUNTIME_POLICY_JSON: JSON.stringify(scoped("agent-a", "openclaw", 2)), TEST_SCHEMA_REJECTED: "1" });
  expect(result.code).toBe(1); expect(result.error).toContain("OPENCLAW_CONFIG_INVALID");
  expect(await fs.readFile(f.configPath, "utf8")).toBe(before);
  expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual(target);
});
it("V2 commit migrates V1 only after CAS and schema success, and recovers without downgrading", async () => {
  const { writeOwnerFencedConfig, configRevision } = await import("../agentControl/ownerFence.js");
  const f = await fixture(); const target = scoped("agent-a", "codex", 1);
  await fs.writeFile(policyFile(f.configPath), JSON.stringify(managedRuntime.defaultPolicy));
  const run = (operation: () => Promise<unknown>) => withManagedRuntimePolicy(f.configPath, target, operation);
  await expect(run(() => writeOwnerFencedConfig(f.configPath, f.text, undefined, { expectedRevision: "stale" }))).rejects.toThrow("CONFIG_CONFLICT");
  await expect(run(() => writeOwnerFencedConfig(f.configPath, f.text, undefined, { expectedRevision: configRevision(f.text), validate: () => Promise.reject(new Error("SCHEMA_REJECTED")) }))).rejects.toThrow("SCHEMA_REJECTED");
  expect(JSON.parse(await fs.readFile(policyFile(f.configPath), "utf8"))).toEqual(managedRuntime.defaultPolicy);
  await run(() => writeOwnerFencedConfig(f.configPath, f.text, undefined, { expectedRevision: configRevision(f.text), validate: () => Promise.resolve() }));
  expect(JSON.parse(await fs.readFile(policyFile(f.configPath), "utf8"))).toEqual(target);
  // Crash/restore left old config after authority commit: converge under retained authority.
  await fs.writeFile(f.configPath, f.text);
  await withManagedRuntimePolicy(f.configPath, undefined, () => normalizeManagedConfigOnDisk(f.configPath));
  expect(await fs.readFile(f.configPath, "utf8")).toContain('"codex"');
  await expect(withManagedRuntimePolicy(f.configPath, managedRuntime.defaultPolicy, () => Promise.resolve())).rejects.toThrow("DOWNGRADE");
});
it("rejects stale preflight revision before credential, config, gateway or authority side effects", async () => {
  const f = await fixture(); const current = scoped();
  await fs.writeFile(policyFile(f.configPath), JSON.stringify(current));
  const input = { ...f, policyAuthority: "backend" as const };
  const proof = await executeAgentControl({ ...input, action: { kind: "managedRuntime.preflight" } });
  if (proof.kind !== "managedRuntime.preflight") throw new Error("preflight required");
  const changed = f.text + "\n";
  await fs.writeFile(f.configPath, changed);
  const gatewayCalls: unknown[] = [];
  const bundle = { profileId: "openai:oauth", accessToken: "prepared", refreshToken: "prepared-refresh", expiresAtMs: Date.now() + 60000, accountId: "account-a", email: null, planType: null };
  await expect(executeAgentControl({ ...input, gateway: { request: (...args: unknown[]) => { gatewayCalls.push(args); return Promise.resolve({}); } }, action: {
    kind: "codex.auth.sync", bundleVersion: 1, bundle,
    managedRuntimeExpectedConfigRevision: proof.configRevision,
    managedRuntimePolicy: scoped("agent-a", null, 1), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256,
  } })).rejects.toMatchObject({ code: "CONFIG_CONFLICT" });
  expect(gatewayCalls).toEqual([]);
  expect(await fs.readFile(f.configPath, "utf8")).toBe(changed);
  expect(JSON.parse(await fs.readFile(policyFile(f.configPath), "utf8"))).toEqual(current);
  expect((await fs.readdir(f.dir)).filter(name => /auth|state|codex/.test(name))).toEqual([]);
});
