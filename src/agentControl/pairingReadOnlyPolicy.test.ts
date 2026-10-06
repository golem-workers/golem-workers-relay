import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const observed = vi.hoisted(() => ({ policies: [] as unknown[] }));
vi.mock("../managed-runtime/runtime-policy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../managed-runtime/runtime-policy.js")>();
  return { ...actual, runtimeContext: async (configPath: string) => {
    observed.policies.push(await actual.readManagedRuntimePolicy(configPath));
    return actual.runtimeContext(configPath);
  } };
});
import { executeAgentControl } from "./executeAgentControl.js";
import { managedRuntime, policyFile } from "../managed-runtime/runtime-policy.js";
import { MANAGED_RUNTIME_SOURCE_SHA256 } from "../managed-runtime/policy.generated.js";
const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); observed.policies.length = 0; await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const scoped = (serverId = "pairing-fixture", revision = 0) => managedRuntime.resolveAgentPolicy(managedRuntime.defaultPolicy, { serverId, harnessOverride: "openclaw", revision });
async function fixture(fail = false, persisted = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pairing-policy-")); directories.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  const text = JSON.stringify({ agents: { defaults: { model: { primary: "openai/gpt-5.5", fallbacks: [] } } } });
  await fs.writeFile(configPath, text);
  const current = scoped();
  const policyText = JSON.stringify(current) + "\n";
  if (persisted) await fs.writeFile(policyFile(configPath), policyText);
  const bin = path.join(dir, "bin"); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "openclaw"), '#!/usr/bin/env node\nif (process.argv[2] !== "pairing" || process.argv[3] !== "list") process.exit(9);\n' + (fail ? 'process.exit(1);' : 'console.log(JSON.stringify({channel:"telegram",requests:[]}));'), { mode: 0o700 });
  vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  vi.stubEnv("HOME", dir);
  const gateway = { request: vi.fn().mockImplementation(() => fail ? Promise.reject(new Error("fixture gateway failure")) : Promise.resolve({ pending: [], paired: [] })) };
  return { configPath, gateway, text, current, policyText };
}
const lists = [{ kind: "channelPairing.list" as const, channel: "telegram" }, { kind: "devicePairing.list" as const }];
for (const action of lists) {
  it.each([false, true])(
    action.kind + " keeps persisted policy on success/failure with legacy higher incoming authority (failure=%s)", async fail => {
      const f = await fixture(fail);
      const result = executeAgentControl({ ...f, policyAuthority: "backend", action: { ...action, managedRuntimePolicy: scoped("pairing-fixture", 1), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 } });
      if (fail) await expect(result).rejects.toThrow();
      else await expect(result).resolves.toMatchObject({ kind: action.kind });
      expect(observed.policies).toEqual([f.current]);
      expect(await fs.readFile(policyFile(f.configPath), "utf8")).toBe(f.policyText);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
    });
  it.each([false, true])(action.kind + " does not activate or create legacy incoming policy when none is persisted (failure=%s)", async fail => {
    const f = await fixture(fail, false);
    const result = executeAgentControl({ ...f, policyAuthority: "backend", action: { ...action, managedRuntimePolicy: scoped("pairing-fixture", 1), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 } });
    if (fail) await expect(result).rejects.toThrow();
    else await expect(result).resolves.toMatchObject({ kind: action.kind });
    expect(observed.policies).toEqual([managedRuntime.defaultPolicy]);
    await expect(fs.access(policyFile(f.configPath))).rejects.toThrow();
    expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  });
  it.each([false, true])(action.kind + " does not create policy from a plain readonly request (failure=%s)", async fail => {
    const f = await fixture(fail, false);
    const result = executeAgentControl({ ...f, action });
    if (fail) await expect(result).rejects.toThrow();
    else await expect(result).resolves.toMatchObject({ kind: action.kind });
    await expect(fs.access(policyFile(f.configPath))).rejects.toThrow();
    expect(await fs.readFile(f.configPath, "utf8")).toBe(f.text);
  });
  it(action.kind + " retains ingress, digest, server and revision guards without policy writes", async () => {
    const f = await fixture();
    const incoming = { ...action, managedRuntimePolicy: scoped("pairing-fixture", 1), managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 };
    await expect(executeAgentControl({ ...f, action: incoming })).rejects.toThrow("Only authenticated backend");
    await expect(executeAgentControl({ ...f, policyAuthority: "backend", action: { ...incoming, managedRuntimePolicyDigest: undefined } })).rejects.toThrow("Backend policy digest is required");
    await expect(executeAgentControl({ ...f, policyAuthority: "backend", action: { ...incoming, managedRuntimePolicyDigest: "0".repeat(64) } })).rejects.toThrow("source digests differ");
    await expect(executeAgentControl({ ...f, policyAuthority: "backend", action: { ...incoming, managedRuntimePolicy: scoped("foreign", 1) } })).rejects.toThrow("SERVER_MISMATCH");
    await expect(executeAgentControl({ ...f, action: { ...action, managedRuntimeExpectedConfigRevision: "stale" } })).rejects.toThrow("Configuration changed");
    expect(f.gateway.request).not.toHaveBeenCalled();
    expect(await fs.readFile(policyFile(f.configPath), "utf8")).toBe(f.policyText);
  });
}
it("device approval still runs in the authenticated mutation policy scope", async () => {
  const f = await fixture();
  const incoming = scoped("pairing-fixture", 1);
  await executeAgentControl({ ...f, policyAuthority: "backend", action: { kind: "devicePairing.approve", requestId: "fixture", managedRuntimePolicy: incoming, managedRuntimePolicyDigest: MANAGED_RUNTIME_SOURCE_SHA256 } });
  expect(observed.policies).toEqual([incoming]);
  expect(f.gateway.request).toHaveBeenCalledWith("device.pair.approve", { requestId: "fixture" });
});
