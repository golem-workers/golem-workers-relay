import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeAgentControl } from "../agentControl/executeAgentControl.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "./policy.generated.js";
const policy = { schemaVersion: 1 as const, revision: 2, chatHarness: "codex" as const };
it("local control cannot forge backend authority and mismatched/missing digests fail before writing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-authority-"));
  const configPath = path.join(dir, "openclaw.json");
  const original = JSON.stringify({ commands: { keep: true } });
  await fs.writeFile(configPath, original);
  const gateway = { request: () => Promise.resolve({}) };
  try {
    const action = { kind: "config.apply" as const, configText: original, managedRuntimePolicy: policy, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
    await expect(executeAgentControl({ configPath, gateway, action })).rejects.toMatchObject({ code: "MANAGED_RUNTIME_POLICY_AUTHORITY_REQUIRED" });
    for (const digest of [undefined, "wrong-release"]) {
      await expect(executeAgentControl({ configPath, gateway, policyAuthority: "backend", action: { ...action, managedRuntimePolicyDigest: digest } })).rejects.toMatchObject({ code: "MANAGED_RUNTIME_POLICY_VERSION_MISMATCH" });
    }
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    await expect(fs.access(configPath + ".managed-runtime-policy.json")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
it("owner writer rejects stale CAS or schema without advancing managed authority", async () => {
  const { writeOwnerFencedConfig, configRevision } = await import("../agentControl/ownerFence.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-schema-"));
  const configPath = path.join(dir, "openclaw.json"); const original = JSON.stringify({ commands: { keep: true } });
  const policyPath = configPath + ".managed-runtime-policy.json"; const priorPolicy = JSON.stringify({ schemaVersion: 1, revision: 1, chatHarness: "openclaw" });
  await fs.writeFile(configPath, original); await fs.writeFile(policyPath, priorPolicy);
  try {
    const authority = { managedRuntimePolicy: policy, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
    await expect(writeOwnerFencedConfig(configPath, original, undefined, { ...authority, expectedRevision: "stale" })).rejects.toThrow("CONFIG_CONFLICT");
    await expect(writeOwnerFencedConfig(configPath, original, undefined, { ...authority, expectedRevision: configRevision(original), validate: () => Promise.reject(new Error("SCHEMA_REJECTED")) })).rejects.toThrow("SCHEMA_REJECTED");
    expect(await fs.readFile(configPath, "utf8")).toBe(original); expect(await fs.readFile(policyPath, "utf8")).toBe(priorPolicy);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
