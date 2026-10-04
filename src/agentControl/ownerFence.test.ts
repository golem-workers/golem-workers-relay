import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
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
