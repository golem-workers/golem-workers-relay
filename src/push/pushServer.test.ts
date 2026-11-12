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
