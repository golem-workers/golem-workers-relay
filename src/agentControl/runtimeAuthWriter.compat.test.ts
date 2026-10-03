import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeRuntimeAuth } from "./runtimeAuthWriter.js";
const originalPath = process.env.PATH;
const roots: string[] = [];
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it.each(["2026.6.11", "2026.9.8"])("uses the public callback contract on %s without issuing schema SQL", async (version) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-contract-")); roots.push(root);
  const pkg = path.join(root, "node_modules/openclaw");
  await fs.mkdir(pkg, { recursive: true });
  await fs.mkdir(path.join(root, "bin"));
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", version, type: "module", exports: { "./plugin-sdk/provider-auth": "./auth.js" } }));
  await fs.writeFile(path.join(pkg, "openclaw.mjs"), "");
  await fs.symlink(path.join(pkg, "openclaw.mjs"), path.join(root, "bin/openclaw"));
  // 2026.6.11's documented function accepts agentDir/saveOptions/updater and
  // ignores newer optional stateDir/sharedStoreWrite fields. Its runtime owns
  // physical persistence, not the relay. This test asserts that boundary only.
  await fs.writeFile(path.join(pkg, "auth.js"), `
    import fs from "node:fs";
    export function updateAuthProfileStoreWithLock({agentDir, updater}) {
      const store = { version: 1, profiles: {
        "openai:old": { type: "oauth", provider: "openai-codex" },
        "openai:api": { type: "api_key", provider: "openai", key: "keep" },
        "anthropic:keep": { type: "api_key", provider: "anthropic", key: "keep" },
      }, order: { anthropic: ["anthropic:keep"] } };
      updater(store);
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH + ".result", JSON.stringify({store, agentDir}));
      return store;
    }
  `);
  process.env.PATH = path.join(root, "bin");
  const configPath = path.join(root, "openclaw.json");
  await writeRuntimeAuth({ configPath, profileId: "openai:new", credential: { type: "oauth", provider: "openai", access: "synthetic", refresh: "synthetic", expires: 4700000000000 } });
  const result = JSON.parse(await fs.readFile(configPath + ".result", "utf8")) as { agentDir: string; store: { profiles: Record<string, unknown>; order: Record<string, string[]> } };
  expect(result.agentDir).toBe(path.join(root, "agents/main/agent"));
  expect(Object.keys(result.store.profiles).sort()).toEqual(["anthropic:keep", "openai:api", "openai:new"]);
  expect(result.store.order).toEqual({ anthropic: ["anthropic:keep"], openai: ["openai:new"] });
  await expect(fs.access(path.join(root, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed without a public SDK, creating no database", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-no-auth-sdk-")); roots.push(root);
  process.env.PATH = root;
  await expect(writeRuntimeAuth({ configPath: path.join(root, "openclaw.json"), profileId: "openai:test", credential: {} })).rejects.toThrow("SDK is unavailable");
  expect(await fs.readdir(root)).toEqual([]);
});
