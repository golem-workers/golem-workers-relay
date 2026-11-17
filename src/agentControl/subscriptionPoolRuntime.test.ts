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
  const calls = request.mock.calls as Array<[string, Record<string, unknown>, { timeoutMs: number }]>;
  expect(calls.map(([method, params]) => [method, params])).toEqual([
    ["agents.list", {}],
    [
      "models.authRefresh",
      { operation: "update", agentId: "main" },
    ],
    [
      "models.authRefresh",
      { operation: "update", agentId: "child" },
    ],
  ]);
  for (const [, , options] of calls) {
    expect(options.timeoutMs).toBeGreaterThan(119_000);
    expect(options.timeoutMs).toBeLessThanOrEqual(120_000);
  }
  request
    .mockReset()
    .mockResolvedValueOnce({ agents: [{ id: "main" }] })
    .mockResolvedValue({ refreshed: false });
  await expect(refreshSubscriptionPoolAuth({ request })).rejects.toMatchObject({ code: "OPENAI_POOL_AUTH_RUNTIME_PENDING" });
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

it("accepts a 99-second post-write refresh within the shared runtime budget", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn((method: string, _params: unknown, options?: { timeoutMs: number }) => {
      if (method === "agents.list") return Promise.resolve({ agents: [{ id: "main" }] });
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error("Gateway request timed out")), options!.timeoutMs);
        setTimeout(() => { clearTimeout(deadline); resolve({ refreshed: true }); }, 99_000);
      });
    });
    const result = refreshSubscriptionPoolAuth({ request });
    const assertion = expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(99_000);
    await assertion;
  } finally { vi.useRealTimers(); }
});

it("shares the refresh deadline across agents rather than multiplying it", async () => {
  vi.useFakeTimers();
  try {
    const budgets: number[] = [];
    const request = vi.fn(async (method: string, _params: unknown, options?: { timeoutMs: number }) => {
      if (method === "agents.list") return { agents: [{ id: "main" }, { id: "child" }] };
      budgets.push(options!.timeoutMs);
      await new Promise(resolve => setTimeout(resolve, 50_000));
      return { refreshed: true };
    });
    const pending = refreshSubscriptionPoolAuth({ request });
    await vi.advanceTimersByTimeAsync(100_000);
    await pending;
    expect(budgets).toEqual([120_000, 70_000]);
  } finally { vi.useRealTimers(); }
});
it("retains a sanitized post-write runtime failure code", async () => {
  const request = vi.fn().mockResolvedValueOnce({ agents: [{ id: "main" }] }).mockRejectedValue(Error("private transport details"));
  await expect(refreshSubscriptionPoolAuth({ request })).rejects.toMatchObject({ code: "OPENAI_POOL_AUTH_RUNTIME_PENDING" });
});

it.each(["agents.list", "models.authRefresh"])("bounds an unresponsive %s even if the transport ignores timeout options", async stalled => {
  vi.useFakeTimers();
  try {
    const request = vi.fn((method: string) => method === stalled ? new Promise(() => {}) : Promise.resolve({ agents: [{ id: "main" }] }));
    const assertion = expect(refreshSubscriptionPoolAuth({ request })).rejects.toMatchObject({ code: "OPENAI_POOL_AUTH_RUNTIME_PENDING" });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
