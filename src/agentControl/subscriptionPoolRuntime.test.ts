import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  refreshSubscriptionPoolAuth,
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


it("activates a saved auth-route change with reload=off, waits through its restart and never restarts an already-applied route", async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"pool-reload-off-")),configPath=path.join(root,"openclaw.json");
 const config={agents:{defaults:{model:{primary:"openai/gpt-5.6-luna",fallbacks:["paid/retained"]}}},models:{providers:{openai:{api:"openai-chatgpt-responses"}}},gateway:{reload:{mode:"off"}}};
 const text=JSON.stringify(config);await fs.writeFile(configPath,text);
 try{
 const applied={valid:true,path:configPath,config,configRevisionHash:"new",appliedConfigHash:"new"};
 const request=vi.fn().mockResolvedValueOnce({...applied,appliedConfigHash:"old"}).mockRejectedValueOnce(Error("restart disconnect")).mockResolvedValue(applied);
 const restart=vi.fn(()=>Promise.resolve());
 await waitForSubscriptionConfigApplied(configPath,text,{request},{runScopedFallbacks:true},restart);
 expect(restart).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledTimes(3);
 restart.mockClear();await waitForSubscriptionConfigApplied(configPath,text,{request},{runScopedFallbacks:true},restart);
 expect(restart).not.toHaveBeenCalled();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
