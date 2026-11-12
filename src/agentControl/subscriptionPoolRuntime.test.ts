import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  refreshSubscriptionPoolAuth,
  readSubscriptionConfigRuntimeState,
  waitForSubscriptionConfigApplied,
} from "./subscriptionPoolRuntime.js";
it("waits for actual Gateway applied hash and refuses pending or unsafe config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pool-runtime-")),
    configPath = path.join(root, "openclaw.json");
  const config = {
    agents: { defaults: { model: { primary: "openai/model", fallbacks: [] } } },
    models: { providers: { openai: { api: "openai-chatgpt-responses" } } },
  };
  const text = JSON.stringify(config);
  await fs.writeFile(configPath, text);
  try {
    const current = {
      valid: true,
      path: configPath,
      config,
      configRevisionHash: "new",
      appliedConfigHash: "new",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ...current,
        config: {
          ...config,
          agents: {
            defaults: {
              model: { primary: "openai/model", fallbacks: ["paid/old"] },
            },
          },
        },
      })
      .mockResolvedValueOnce({ ...current, appliedConfigHash: "old" })
      .mockResolvedValue(current);
    await waitForSubscriptionConfigApplied(configPath, text, { request });
    expect(request).toHaveBeenCalledTimes(3);
    await expect(
      waitForSubscriptionConfigApplied(configPath, "stale", { request }),
    ).rejects.toThrow("CONFIG_CONFLICT");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(61_000);
    const pending = waitForSubscriptionConfigApplied(configPath, text, {
      request: vi
        .fn()
        .mockResolvedValue({ ...current, appliedConfigHash: "old" }),
    });
    const rejected = expect(pending).rejects.toThrow(
      "OPENAI_POOL_CONFIG_RUNTIME_PENDING",
    );
    await rejected;
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("requires post-mutation refresh acknowledgments for every live configured agent", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ agents: [{ id: "main" }, { id: "child" }] })
    .mockResolvedValue({ refreshed: true });
  await refreshSubscriptionPoolAuth({ request });
  expect(request.mock.calls).toEqual([
    ["agents.list", {}, { timeoutMs: 3000 }],
    [
      "models.authRefresh",
      { operation: "update", agentId: "main" },
      { timeoutMs: 10000 },
    ],
    [
      "models.authRefresh",
      { operation: "update", agentId: "child" },
      { timeoutMs: 10000 },
    ],
  ]);
  request
    .mockReset()
    .mockResolvedValueOnce({ agents: [{ id: "main" }] })
    .mockResolvedValue({ refreshed: false });
  await expect(refreshSubscriptionPoolAuth({ request })).rejects.toThrow(
    "OPENAI_POOL_AUTH_RUNTIME_PENDING",
  );
});


it("requires explicit config application when reload is off and never restarts Gateway from auth-only work", async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"pool-reload-off-")),configPath=path.join(root,"openclaw.json");
 const config={agents:{defaults:{model:{primary:"openai/gpt-5.6-luna",fallbacks:[]}}},models:{providers:{openai:{api:"openai-chatgpt-responses"}}},gateway:{reload:{mode:"off"}}};
 const text=JSON.stringify(config);await fs.writeFile(configPath,text);
 try {
  const applied={valid:true,path:configPath,config,configRevisionHash:"new",appliedConfigHash:"new"};
  const request=vi.fn().mockResolvedValueOnce({...applied,appliedConfigHash:"old"}).mockResolvedValue(applied);
  const restart=vi.fn(()=>Promise.resolve());
  await expect(waitForSubscriptionConfigApplied(configPath,text,{request},{runScopedFallbacks:true},restart)).rejects.toMatchObject({code:"OPENAI_POOL_CONFIG_RUNTIME_PENDING"});
  expect(restart).not.toHaveBeenCalled();
  await waitForSubscriptionConfigApplied(configPath,text,{request},{runScopedFallbacks:true},restart);
  expect(restart).not.toHaveBeenCalled();
 } finally {await fs.rm(root,{recursive:true,force:true});}
});

it.each([
  [{valid:true,path:"/fixture/config",configRevisionHash:"same",appliedConfigHash:"same"},"applied"],
  [{valid:true,path:"/fixture/config",configRevisionHash:"new",appliedConfigHash:"old"},"pending"],
  [{valid:false,path:"/fixture/config",configRevisionHash:"same",appliedConfigHash:"same"},"pending"],
  [{valid:true,path:"/other/config",configRevisionHash:"same",appliedConfigHash:"same"},"pending"],
  [{valid:true,path:"/fixture/config"},"unavailable"],
] as const)("reads applied config evidence without authoring settings: %j", async (value, expected) => {
  const request=vi.fn(()=>Promise.resolve(value));
  await expect(readSubscriptionConfigRuntimeState("/fixture/config",{request})).resolves.toBe(expected);
  expect(request).toHaveBeenCalledExactlyOnceWith("config.get",{},{timeoutMs:3000});
});
it("contains a failed read-only config request without restarting Gateway", async()=>{
 const request=vi.fn(()=>Promise.reject(Error("private transport failure")));
 await expect(readSubscriptionConfigRuntimeState("/fixture/config",{request})).resolves.toBe("unavailable");
 expect(request).toHaveBeenCalledOnce();
});
