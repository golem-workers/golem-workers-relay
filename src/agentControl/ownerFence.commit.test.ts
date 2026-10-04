import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeOwnerFencedConfig, readOwnerFence } from "./ownerFence.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "commit-fence-")); dirs.push(dir); const file = path.join(dir, "custom-config.json"); await fs.writeFile(file, "{}"); return file; }
const fence = { revision: "1", active: [], revoked: ["123"] };
it("rejects stale full config without losing a concurrent model change", async () => {
 const file = await fixture();
 await fs.writeFile(file, '{"model":"new"}');
 await expect(writeOwnerFencedConfig(file, '{"auth":"new"}', fence, { expectedConfigText: "{}", validate: () => Promise.resolve() })).rejects.toThrow("CONFIG_CONFLICT");
 expect(await fs.readFile(file, "utf8")).toBe('{"model":"new"}');
 expect(await readOwnerFence(file)).toBeNull();
});
it("candidate rejection leaves both config and enrollment unchanged", async () => {
 const file = await fixture();
 await expect(writeOwnerFencedConfig(file, '{"bad":true}', fence, { expectedConfigText: "{}", validate: () => Promise.reject(new Error("candidate rejected")) })).rejects.toThrow("candidate rejected");
 expect(await fs.readFile(file, "utf8")).toBe("{}");
 expect(await readOwnerFence(file)).toBeNull();
});

it("rejects stale rollback after a newer config commit", async () => {
 const file = await fixture();
 const first = await writeOwnerFencedConfig(file, '{"model":"first"}', undefined, { expectedConfigText: "{}" });
 await writeOwnerFencedConfig(file, '{"model":"second","auth":"keep"}', undefined, { expectedRevision: first });
 await expect(writeOwnerFencedConfig(file, "{}", undefined, { expectedRevision: first })).rejects.toThrow("CONFIG_CONFLICT");
 expect(JSON.parse(await fs.readFile(file, "utf8")) as unknown).toEqual({ model: "second", auth: "keep" });
});
