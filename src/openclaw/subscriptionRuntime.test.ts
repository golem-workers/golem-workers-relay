import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ sdk: "" }));
vi.mock("../agentControl/runtimeAuthWriter.js", () => ({
  resolveRuntimeAuthSdk: () => Promise.resolve(mock.sdk),
}));
import { readSubscriptionRuntime } from "./subscriptionRuntime.js";
let root: string;
let configPath: string;
const a = "openai:golem-a";
const b = "openai:golem-b";
const state = () => ({
  entry: {
    sessionId: "same-session",
    updatedAt: 123,
    authProfileOverride: a,
    authProfileOverrideSource: "auto",
  },
  stats: {} as Record<string, unknown>,
  profiles: { [a]: { type: "oauth", provider: "openai", access: "never-report-this" }, [b]: { type: "oauth", provider: "openai", access: "never-report-this" } },
  race: false,
});
async function write(value: unknown) {
  await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify(value));
}
async function read() {
  return JSON.parse(await fs.readFile(path.join(root, "fixture.json"), "utf8")) as {entry: Record<string, unknown>; writes?: number};
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "subscription-preflight-"));
  configPath = path.join(root, "openclaw.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      agents: { defaults: { model: { primary: "openai/test" } } },
    }),
  );
  await fs.writeFile(
    configPath + ".golem-openai-pool.json",
    JSON.stringify({
      version: 1,
      revision: 2,
      phase: "applied",
      fingerprint: "a".repeat(64),
      managedProfileIds: [a, b],
      members: [a, b].map((profileId, i) => ({
        accountId: i ? "b" : "a",
        profileId,
        enabled: true,
        credentialVersion: 1,
        credentialDigest: "a".repeat(64),
      })),
    }),
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: {
        "./plugin-sdk/provider-auth": "./auth.mjs",
        "./plugin-sdk/session-store-runtime": "./session.mjs",
        "./plugin-sdk/runtime-config-snapshot": "./config.mjs",
      },
    }),
  );
  mock.sdk = path.join(root, "auth.mjs");
  await fs.writeFile(
    mock.sdk,
    `import fs from 'node:fs';const file=()=>process.env.OPENCLAW_STATE_DIR+'/fixture.json';export async function ensureAuthProfileStoreAsync(){const s=JSON.parse(fs.readFileSync(file()));return {profiles:s.profiles,usageStats:s.stats};}`,
  );
  await fs.writeFile(
    path.join(root, "session.mjs"),
    `import fs from 'node:fs';const file=()=>process.env.OPENCLAW_STATE_DIR+'/fixture.json';const read=()=>JSON.parse(fs.readFileSync(file()));export async function getSessionEntryAsync(){return read().entry;}export async function patchSessionEntry(p){const s=read();if(s.race)s.entry.authProfileOverride='openai:golem-b';const patch=p.update(s.entry);if(patch){s.entry={...s.entry,...patch};s.writes=(s.writes??0)+1;}fs.writeFileSync(file(),JSON.stringify(s));}export function loadTranscriptEventsSync(){return [{type:'message',id:'event-1',timestamp:'2026-11-09T00:00:00.000Z',message:{role:'assistant',provider:'openai',model:'test',stopReason:'stop',content:'private prompt',usage:{input:10,output:2,totalTokens:12}}}];}`,
  );
  await fs.writeFile(
    path.join(root, "config.mjs"),
    "export function setRuntimeConfigSnapshot(){}",
  );
  await write(state());
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
it("clears only a cooldowned auto pin without resetting history or activity", async () => {
  const s = state();
  s.stats[a] = { cooldownUntil: Date.now() + 60000 };
  await write(s);
  const result = await readSubscriptionRuntime({
    configPath,
    sessionKey: "agent:main:original",
    prepare: true,
  });
  expect(result).toMatchObject({
    sessionId: "same-session",
    clearedAutoPin: true,
    rows: [],
  });
  expect(
    (
      await readSubscriptionRuntime({
        configPath,
        sessionKey: "agent:main:original",
      })
    )?.rows,
  ).toMatchObject([{ messageId: "event-1", total: 12 }]);
  const after = await read();
  expect(after.entry).toEqual({ sessionId: "same-session", updatedAt: 123 });
  expect(JSON.stringify(result)).not.toMatch(
    /never-report-this|private prompt|access/,
  );
});
it.each(["user", "manual"])(
  "does not override explicit %s selection",
  async (source) => {
    const s = state();
    s.entry.authProfileOverrideSource = source;
    s.stats[a] = { cooldownUntil: Date.now() + 60000 };
    await write(s);
    expect(
      (
        await readSubscriptionRuntime({
          configPath,
          sessionKey: "agent:main:x",
          prepare: true,
        })
      )?.clearedAutoPin,
    ).toBe(false);
    expect((await read()).writes).toBeUndefined();
  },
);
it("retains healthy, expired-cooldown, and other-model pins", async () => {
  for (const stats of [
    {},
    { cooldownUntil: Date.now() - 1 },
    {
      cooldownUntil: Date.now() + 60000,
      cooldownModel: "another",
      cooldownReason: "rate_limit",
    },
  ]) {
    const s = state();
    s.stats[a] = stats;
    await write(s);
    expect(
      (
        await readSubscriptionRuntime({
          configPath,
          sessionKey: "agent:main:x",
          prepare: true,
        })
      )?.profileId,
    ).toBe(a);
    expect((await read()).writes).toBeUndefined();
  }
});
it("does not clear a concurrent newer selection", async () => {
  const s = state();
  s.race = true;
  s.stats[a] = { disabledUntil: Date.now() + 60000 };
  await write(s);
  expect(
    (
      await readSubscriptionRuntime({
        configPath,
        sessionKey: "agent:main:x",
        prepare: true,
      })
    )?.profileId,
  ).toBe(b);
  expect((await read()).writes).toBeUndefined();
});
it("does not mutate foreign profiles or nested-agent stores", async () => {
  const s = state();
  s.entry.authProfileOverride = "anthropic:other";
  await write(s);
  expect(
    (
      await readSubscriptionRuntime({
        configPath,
        sessionKey: "agent:main:x",
        prepare: true,
      })
    )?.clearedAutoPin,
  ).toBe(false);
  expect(
    await readSubscriptionRuntime({
      configPath,
      sessionKey: "agent:other:x",
      prepare: true,
    }),
  ).toBeNull();
});
it("does not touch legacy agents without a pool", async () => {
  await fs.rm(configPath + ".golem-openai-pool.json");
  expect(
    await readSubscriptionRuntime({
      configPath,
      sessionKey: "x",
      prepare: true,
    }),
  ).toBeNull();
});

it("refuses all-exhausted dispatch even if an API profile exists, without changing the session", async () => {
  const s = state(); s.stats[a] = {cooldownUntil: Date.now()+60000}; s.stats[b] = {disabledUntil: Date.now()+60000};
  await write({...s, profiles: {...s.profiles, "openai:api": {type:"api_key",provider:"openai",key:"synthetic"}}});
  await expect(readSubscriptionRuntime({configPath,sessionKey:"agent:main:x",prepare:true})).rejects.toThrow("OPENAI_SUBSCRIPTIONS_EXHAUSTED");
  expect((await read()).writes).toBeUndefined();
});
it("refuses an API credential substituted into a managed profile", async () => {
  const s=state();await write({...s,profiles:{[a]:{type:"api_key",provider:"openai",key:"synthetic"}}});
  await expect(readSubscriptionRuntime({configPath,sessionKey:"agent:main:x",prepare:true})).rejects.toThrow("OPENAI_SUBSCRIPTIONS_EXHAUSTED");
});
