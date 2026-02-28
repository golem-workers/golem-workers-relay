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
    const port = await getFreePort();
    const server = startPushServer({
      port,
      path: "/relay/messages",
      relayToken: "token",
      getHealth: () => ({ ok: true, ready: false, details: { queueLength: 10 } }),
      onMessage: async () => {},
    });
    servers.push(server);

    const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResp.status).toBe(200);
    const healthJson = (await healthResp.json()) as { ok: boolean };
    expect(healthJson.ok).toBe(true);

    const readyResp = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyResp.status).toBe(503);
  });

  it("applies request rate limiting", async () => {
    const port = await getFreePort();
    const server = startPushServer({
      port,
      path: "/relay/messages",
      relayToken: "token",
      rateLimitPerSecond: 1,
      onMessage: async () => {},
    });
    servers.push(server);

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
});

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to determine free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
