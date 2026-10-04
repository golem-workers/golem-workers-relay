import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { executeAgentControl } from "./executeAgentControl.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const gateway = { request: () => Promise.reject(new Error("fixture no gateway")) };
it.each([false, true])("actual normalized apply receipt supports safe rollback, newer commit=%s", async newer => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-receipt-")); dirs.push(dir);
 const configPath = path.join(dir, "openclaw.json");
 const old = { commands: { ownerAllowFrom: [" 123 ", "discord:123"] }, agents: { defaults: { model: "openai/gpt-6.1-sol", models: { "openai/gpt-6.1-sol": {} } } } };
 await fs.writeFile(configPath, JSON.stringify(old));
 const requested = JSON.stringify({ ...old, commands: { ownerAllowFrom: ["123", "discord:123"] } });
 const result = await executeAgentControl({ configPath, gateway, action: { kind: "config.apply", configText: requested, ownerFence: { revision: "2", active: [], revoked: ["123"] } } });
 if (result.kind !== "config.apply") throw new Error("unexpected result");
 expect(result.committedConfigText).not.toBe(requested);
 expect(result.committedRevision).toBe(createHash("sha256").update(await fs.readFile(configPath, "utf8")).digest("hex"));
 expect((JSON.parse(result.committedConfigText!) as { models: { providers: { openai: { models: unknown[] } } } }).models.providers.openai.models.length).toBeGreaterThan(0);
 if (newer) await executeAgentControl({ configPath, gateway, action: { kind: "config.apply", configText: JSON.stringify({ commands: { ownerAllowFrom: ["custom:keep"] }, env: { KEEP: "newer" } }) } });
 const rollback = executeAgentControl({ configPath, gateway, action: { kind: "config.apply", configText: JSON.stringify(old), expectedRevision: result.committedRevision } });
 if (newer) { await expect(rollback).rejects.toThrow("CONFIG_CONFLICT"); expect((JSON.parse(await fs.readFile(configPath, "utf8")) as { env: unknown }).env).toEqual({ KEEP: "newer" }); }
 else {
  const restored = await rollback;
  if (restored.kind !== "config.apply") throw new Error("unexpected result");
  expect((JSON.parse(restored.committedConfigText!) as { commands: { ownerAllowFrom: string[] } }).commands.ownerAllowFrom).toEqual(["discord:123"]);
  expect(restored.committedConfigText).toBe(await fs.readFile(configPath, "utf8"));
 }
});
