import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeOwnerFencedConfig } from "./ownerFence.js";
type Config = { commands: { ownerAllowFrom: string[] }; channels: unknown; tools: unknown };
function parse(text: string) { return JSON.parse(text) as Config; }
const directories: string[] = [];
async function fixture() { const dir = await mkdtemp(path.join(tmpdir(), "owner-fence-")); directories.push(dir); return path.join(dir, "openclaw.json"); }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const active = { revision: "1", active: ["123"], revoked: [] };
const revoked = { revision: "2", active: [], revoked: ["123"] };
const original = JSON.stringify({ commands: { ownerAllowFrom: ["telegram:123", "custom:keep"] }, channels: { telegram: { allowFrom: ["keep"] } }, tools: { elevated: { enabled: false } } });
it("rejects stale late completion after revoke and preserves unrelated policy", async () => {
 const file = await fixture();
 await writeOwnerFencedConfig(file, original, active);
 await writeOwnerFencedConfig(file, original, revoked);
 await expect(writeOwnerFencedConfig(file, original, active)).rejects.toThrow("STALE_OWNER_REVISION");
 const result = parse(await readFile(file, "utf8"));
 expect(result.commands.ownerAllowFrom).toEqual(["custom:keep"]);
 expect(result.channels).toEqual(parse(original).channels);
 expect(result.tools).toEqual(parse(original).tools);
});
it("projects persisted revocation onto unversioned model/auth rollback", async () => {
 const file = await fixture();
 await writeOwnerFencedConfig(file, original, revoked);
 await writeOwnerFencedConfig(file, original);
 expect(parse(await readFile(file, "utf8")).commands.ownerAllowFrom).toEqual(["custom:keep"]);
});
it("rejects conflicting equal revisions but preserves visible wildcard authority", async () => {
 const file = await fixture();
 await writeOwnerFencedConfig(file, original, active);
 await expect(writeOwnerFencedConfig(file, original, { ...revoked, revision: "1" })).rejects.toThrow("OWNER_REVISION_CONFLICT");
 await writeOwnerFencedConfig(file, '{"commands":{"ownerAllowFrom":["*"]}}', revoked);
 expect(parse(await readFile(file, "utf8")).commands.ownerAllowFrom).toEqual(["*"]);
});

it("rejects a stale writer in another process after durable revocation", async () => {
 const { execFile } = await import("node:child_process");
 const { promisify } = await import("node:util");
 const file = await fixture();
 await writeOwnerFencedConfig(file, original, revoked);
 const moduleUrl = new URL("./ownerFence.ts", import.meta.url).href;
 const source = "import { writeOwnerFencedConfig } from " + JSON.stringify(moduleUrl) + "; await writeOwnerFencedConfig(process.argv[1], process.argv[2], JSON.parse(process.argv[3]));";
 await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, file, original, JSON.stringify(active)], { env: { PATH: process.env.PATH, HOME: process.env.HOME } })).rejects.toThrow("STALE_OWNER_REVISION");
 expect(parse(await readFile(file, "utf8")).commands.ownerAllowFrom).toEqual(["custom:keep"]);
});

it("reports a crash-persisted fence without treating absent config as success", async () => {
 const file = await fixture();
 await expect(writeOwnerFencedConfig(file, original, revoked, { validate: async () => {
 
   // Simulate a filesystem failure after validation, before config rename.
   await mkdir(file);
 } })).rejects.toBeDefined();
 await rm(file, { recursive: true });
 await expect(writeOwnerFencedConfig(file, original, active)).rejects.toThrow("STALE_OWNER_REVISION");
 await writeOwnerFencedConfig(file, original);
 expect(parse(await readFile(file, "utf8")).commands.ownerAllowFrom).toEqual(["custom:keep"]);
});

it("removes padded numeric and Telegram aliases but preserves other channels and wildcard", async () => {
 const file = await fixture();
 await writeOwnerFencedConfig(file, JSON.stringify({ commands: { ownerAllowFrom: [" 123 ", " telegram:123 ", " tg:123 ", "telegram: 123", "discord:123", "whatsapp:123", " * "] } }), revoked);
 expect(parse(await readFile(file, "utf8")).commands.ownerAllowFrom).toEqual(["discord:123", "whatsapp:123", " * "]);
});

it("public port projection permits only operational metadata and retains model/auth/env and CAS fences", async () => {
 const { withModelFenceLock, writeModelFence } = await import('./modelFence.js');
 const file = await fixture();
 await writeOwnerFencedConfig(file, JSON.stringify({ agents: { defaults: { model: { primary: 'openai/current' } } }, env: { vars: { PROTECTED_KEY: 'synthetic', GW_AGENT_PUBLIC_HOST: 'old' } }, models: { providers: { openai: { apiKey: 'synthetic-auth' } } } }), active);
 await withModelFenceLock(file, () => writeModelFence(file, { revision: 'current', predecessor: null, status: 'APPLIED', model: 'openai/current' }));
 const before = await readFile(file, 'utf8');
 const candidate = JSON.parse(before) as { env: { vars: Record<string, string> }; agents: { defaults: { model: { primary: string } } }; models: { providers: { openai: { apiKey: string } } } }; candidate.env.vars.GW_AGENT_PUBLIC_HOST = 'new'; candidate.env.vars.GW_AGENT_PUBLIC_PORT = '18005'; candidate.env.vars.GW_AGENT_PUBLIC_HTTP_URL = 'http://new:18005';
 await expect(writeOwnerFencedConfig(file, JSON.stringify(candidate), undefined, { expectedConfigText: before })).rejects.toThrow('MODEL_FENCE_REQUIRED');
 await expect(writeOwnerFencedConfig(file, JSON.stringify(candidate), undefined, { operationalPublicPort: true })).rejects.toThrow('MODEL_FENCE_REQUIRED');
 await writeOwnerFencedConfig(file, JSON.stringify(candidate), undefined, { operationalPublicPort: true, expectedConfigText: before });
 const committed = await readFile(file, 'utf8');
 expect((JSON.parse(committed) as typeof candidate).env.vars.PROTECTED_KEY).toBe('synthetic');
 for (const mutate of [(c: typeof candidate) => { c.env.vars.PROTECTED_KEY = 'changed'; }, (c: typeof candidate) => { c.agents.defaults.model.primary = 'openai/old'; }, (c: typeof candidate) => { c.models.providers.openai.apiKey = 'changed'; }]) {
  const changed = structuredClone(candidate); mutate(changed);
  await expect(writeOwnerFencedConfig(file, JSON.stringify(changed), undefined, { operationalPublicPort: true, expectedConfigText: committed })).rejects.toThrow('MODEL_FENCE_REQUIRED');
 }
 await expect(writeOwnerFencedConfig(file, JSON.stringify(candidate), undefined, { operationalPublicPort: true, expectedConfigText: before })).rejects.toThrow('CONFIG_CONFLICT');
 expect(await readFile(file, 'utf8')).toBe(committed);
});

it("fallback cleanup authority cannot change model, reasoning, auth or bypass CAS",async()=>{
 const {writeFile}=await import("node:fs/promises");
 const {withAuthorizationConfig}=await import("../managed-runtime/runtime-policy.js");
 const {clearSubscriptionModelFallbacks}=await import("./subscriptionModelFallbacks.js");
 const file=await fixture();
 const before=JSON.stringify({agents:{defaults:{model:{primary:"openai/current",fallbacks:["paid/other"]},thinkingDefault:"high"}},env:{KEEP:"synthetic"}});
 await writeFile(file,before);
 const candidate=clearSubscriptionModelFallbacks(JSON.parse(before) as Record<string,unknown>);
 const write=(c:unknown, expected=before)=>withAuthorizationConfig(file,()=>writeOwnerFencedConfig(file,JSON.stringify(c),undefined,{expectedConfigText:expected,subscriptionPoolFallbackCleanup:true}));
 for(const patch of [{agents:{}},{env:{KEEP:"changed"}}]) await expect(write({...candidate,...patch})).rejects.toThrow("MODEL_FENCE_REQUIRED");
 await expect(write(candidate,"{}")).rejects.toThrow("CONFIG_CONFLICT");
 expect(await readFile(file,"utf8")).toBe(before);
 await write(candidate);
 expect(JSON.parse(await readFile(file,"utf8"))).toEqual(candidate);
});

it("Connect route authority permits only the exact generated auth repair, retaining model/owner fences and CAS", async () => {
 const {writeFile}=await import("node:fs/promises");
 const {withAuthorizationConfig}=await import("../managed-runtime/runtime-policy.js");
 const {prepareSubscriptionPoolConfig}=await import("./subscriptionPoolConfig.js");
 const {withModelFenceLock,writeModelFence,readModelFence}=await import("./modelFence.js");
 vi.stubEnv("BACKEND_BASE_URL","https://dev-api.golemworkers.com");
 try {
 const file=await fixture();
 const before=JSON.stringify({agents:{defaults:{model:{primary:"openai/gpt-5.6-luna",fallbacks:[]},thinkingDefault:"high"}},models:{providers:{openai:{baseUrl:"https://dev-api.golemworkers.com/api/v1/relays/openai/v1",models:[],agentRuntime:{id:"openclaw"}}}},env:{KEEP:"synthetic"}});
 await writeFile(file,before);
 await withModelFenceLock(file,()=>writeModelFence(file,{revision:"fresh",predecessor:null,status:"APPLIED",model:"openai/gpt-5.6-luna"}));
 const fence=await readModelFence(file);
 const guard={runScopedFallbacks:false};
 const candidate=prepareSubscriptionPoolConfig(JSON.parse(before) as Record<string,unknown>,guard);
 const write=(c:unknown,expected=before)=>withAuthorizationConfig(file,()=>writeOwnerFencedConfig(file,JSON.stringify(c),undefined,{expectedConfigText:expected,subscriptionPoolConnect:guard}));
 for(const patch of [{agents:{}},{env:{KEEP:"changed"}},{models:{providers:{openai:{apiKey:"bad"}}}}])await expect(write({...candidate,...patch})).rejects.toThrow("MODEL_FENCE_REQUIRED");
 await expect(write(candidate,"{}")).rejects.toThrow("CONFIG_CONFLICT");
 expect(await readFile(file,"utf8")).toBe(before);
 await write(candidate);
 expect(JSON.parse(await readFile(file,"utf8"))).toEqual(candidate);
 expect(await readModelFence(file)).toEqual(fence);
 }finally{vi.unstubAllEnvs();}
});
