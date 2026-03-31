import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
