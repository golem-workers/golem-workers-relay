import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isAuthorizationReadbackOnly } from "../agentControl/authorizationReconcileContext.js";
import { AgentControlError } from "../agentControl/errors.js";
import { RuntimeAuthWriterError } from "../agentControl/runtimeAuthWriter.js";
import { ModelFenceBusyError } from "../agentControl/modelFence.js";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPushServer } from "./pushServer.js";

describe("pushServer", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    servers.length = 0;
  });

  it("admits exact explicit partial reconciliation over authenticated HTTP without another writer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "partial-reconcile-http-"));
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    let writes = 0, readbacks = 0;
    try {
      const { port } = await startTestPushServer({ port: 0, path: "/relay/messages", relayToken: "token", rateLimitPerSecond: 1000, onMessage: async () => {},
        onAgentControl: () => {
          if (!isAuthorizationReadbackOnly()) { writes++; return Promise.reject(new RuntimeAuthWriterError("AUTH_POOL_WRITER_SESSION_REFRESH_FAILED_EXIT_9_NONE", "synthetic-private-detail")); }
          readbacks++; return Promise.resolve({ kind: "codex.auth.pool.sync" as const, revision: 1, phase: "applied" as const, members: [] });
        },
      }, servers);
      const action = { kind: "codex.auth.pool.sync", revision: 1, members: [] };
      type ResponseBody = { code?: string; receipt?: { state: string; fingerprint: string; reconcileCount?: number } };
      const post = async (mode: string, resumeFrom?: string, revision = 1) => {
        const response = await fetch(`http://127.0.0.1:${port}/relay/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify({ messageId: "partial", input: { kind: "agent_control", action: mode === "status" ? { kind: "config.read" } : { ...action, revision }, durableOperation: { id: "partial", mode, ...(resumeFrom ? { resumeFrom } : {}) } } }) });
        return { status: response.status, body: await response.json() as ResponseBody };
      };
      expect((await post("submit")).status).toBe(200);
      let receipt: ResponseBody["receipt"];
      await vi.waitFor(async () => { receipt = (await post("status")).body.receipt; expect(receipt?.state).toBe("UNKNOWN"); });
      expect(writes).toBe(1); expect(readbacks).toBe(0);
      expect((await post("reconcile")).status).toBe(400);
      expect((await post("reconcile", receipt!.fingerprint, 2)).body.code).toBe("AUTH_OPERATION_CONFLICT");
      expect((await post("reconcile", receipt!.fingerprint)).status).toBe(200);
      await vi.waitFor(async () => { expect((await post("status")).body.receipt).toMatchObject({ state: "SUCCEEDED", reconcileCount: 1 }); });
      await post("submit"); expect(writes).toBe(1); expect(readbacks).toBe(1);
      expect(await fs.readFile(path.join(root, "relay-authorization-receipts/partial.json"), "utf8")).not.toContain("synthetic-private-detail");
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves health/readiness endpoints", async () => {
    const { port } = await startTestPushServer(
      {
        port: 0,
        path: "/relay/messages",
        relayToken: "token",
        getHealth: () => ({ ok: true, ready: false, details: { queueLength: 10 } }),
        onMessage: async () => {},
      },
      servers
    );

    const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResp.status).toBe(200);
    const healthJson = (await healthResp.json()) as { ok: boolean };
    expect(healthJson.ok).toBe(true);

    const readyResp = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyResp.status).toBe(503);
  });

  it("applies request rate limiting", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const { port } = await startTestPushServer(
      {
        port: 0,
        path: "/relay/messages",
        relayToken: "token",
        rateLimitPerSecond: 1,
        onMessage: async () => {},
      },
      servers
    );

    const body = {
      messageId: "m1",
      input: { kind: "handshake", nonce: "n1" },
    };
    const first = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({ ...body, messageId: "m2" }),
    });
    expect(second.status).toBe(429);
    nowSpy.mockRestore();
  });

  it("stays alive when the client disconnects during request upload", async () => {
    const { port } = await startTestPushServer(
      {
        port: 0,
        path: "/relay/messages",
        relayToken: "token",
        onMessage: async () => {},
      },
      servers
    );

    await new Promise<void>((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/relay/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer token",
          },
        },
        () => resolve()
      );
      req.once("error", () => resolve());
      req.write('{"messageId":"m1","input":{"kind":"chat","sessionKey":"s1","messageText":"partial');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 20);
    });

    await sleep(50);

    const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResp.status).toBe(200);
    const healthJson = (await healthResp.json()) as { ok: boolean };
    expect(healthJson.ok).toBe(true);
  });

  it("routes transport_event payloads to the dedicated callback", async () => {
    const seenEvents: unknown[] = [];
    const { port } = await startTestPushServer(
      {
        port: 0,
        path: "/relay/messages",
        relayToken: "token",
        onMessage: () => {
          throw new Error("chat callback should not be used");
        },
        onTransportEvent: (message) => {
          seenEvents.push(message);
          return Promise.resolve();
        },
      },
      servers
    );

    const resp = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        messageId: "evt_1",
        input: {
          kind: "transport_event",
          event: {
            type: "event",
            eventType: "transport.typing.updated",
            payload: {
              eventId: "typing-1",
              accountId: "default",
              conversation: {
                handle: "123",
              },
              typing: {
                active: true,
              },
            },
          },
        },
      }),
    });

    expect(resp.status).toBe(200);
    expect(seenEvents).toHaveLength(1);
  });

  it.each([
    [new AgentControlError("MODEL_VERIFY_MISMATCH", "secret-runtime-output"), 409, "MODEL_VERIFY_MISMATCH"],
    [new Error("Gateway request timed out: config.get"), 504, "RUNTIME_GATEWAY_TIMEOUT"],
  ])("preserves safe runtime diagnostic without exposing arbitrary exception text", async (error, status, code) => {
    const { port } = await startTestPushServer({ port: 0, path: "/relay/messages", relayToken: "token", onMessage: async () => {}, onAgentControl: () => Promise.reject(error) }, servers);
    const resp = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ messageId: "safe-error", input: { kind: "agent_control", action: { kind: "config.read" } } }),
    });
    expect(resp.status).toBe(status);
    const body = await resp.json();
    expect(body).toMatchObject({code});
    expect(JSON.stringify(body)).not.toContain("secret-runtime-output");
  });
  it("returns safe typed writer diagnostics without exception contents", async () => {
    const onAgentControl = vi.fn().mockRejectedValue(new RuntimeAuthWriterError("AUTH_POOL_WRITER_STORE_REFUSED_EXIT_3_NONE", "secret-token and stderr"));
    const { port } = await startTestPushServer({ port: 0, path: "/relay/messages", relayToken: "token", onMessage: async () => {}, onAgentControl }, servers);
    const resp = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ messageId: "writer", input: { kind: "agent_control", action: { kind: "codex.auth.clear" } } }),
    });
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body).toMatchObject({ code: "AUTH_POOL_WRITER_STORE_REFUSED_EXIT_3_NONE", stage: "auth_writer", mutationState: "unknown" });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(onAgentControl).toHaveBeenCalledOnce();
  });

  it.each([true, false])("only exposes typed pre-mutation model contention: %s", async busy => {
    const onAgentControl = vi.fn().mockRejectedValue(busy ? new ModelFenceBusyError() : new Error("MODEL_FENCE_BUSY"));
    const { port } = await startTestPushServer({ port: 0, path: "/relay/messages", relayToken: "token", onMessage: async () => {}, onAgentControl }, servers);
    const resp = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ messageId: "busy", input: { kind: "agent_control", action: { kind: "codex.auth.clear" } } }),
    });
    expect(resp.status).toBe(busy ? 409 : 500);
    expect(await resp.json()).toMatchObject({ code: busy ? "MODEL_FENCE_BUSY" : "PUSH_SERVER_ERROR" });
    expect(onAgentControl).toHaveBeenCalledTimes(1);
  });

  it("handles agent_control payloads synchronously", async () => {
    const onAgentControl = vi.fn().mockResolvedValue({
      kind: "devicePairing.list",
      pending: [{ requestId: "req_1" }],
      paired: [{ deviceId: "dev_1" }],
    });
    const { port } = await startTestPushServer(
      {
        port: 0,
        path: "/relay/messages",
        relayToken: "token",
        onMessage: () => {
          throw new Error("chat callback should not be used");
        },
        onAgentControl,
      },
      servers
    );

    const resp = await fetch(`http://127.0.0.1:${port}/relay/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token",
      },
      body: JSON.stringify({
        messageId: "ctl_1",
        input: {
          kind: "agent_control",
          action: {
            kind: "devicePairing.list",
          },
        },
      }),
    });

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      accepted: true,
      result: {
        kind: "devicePairing.list",
        pending: [{ requestId: "req_1" }],
        paired: [{ deviceId: "dev_1" }],
      },
    });
    expect(onAgentControl).toHaveBeenCalledTimes(1);
  });
});

async function startTestPushServer(
  input: Parameters<typeof startPushServer>[0],
  servers: http.Server[]
): Promise<{ server: http.Server; port: number }> {
  const server = startPushServer(input);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to determine push server port");
  }
  servers.push(server);
  return { server, port: addr.port };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
