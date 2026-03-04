import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startOpenRouterProxyServer } from "./proxyServer.js";

describe("startOpenRouterProxyServer", () => {
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

  it("forwards non-stream OpenRouter requests to backend proxy", async () => {
    const backendPort = await getFreePort();
    let backendAuthHeader: string | null = null;
    const backendServer = http.createServer(async (req, res) => {
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "resp_1", model: "openrouter/test", usage: { input_tokens: 10 } }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenRouterProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/api/v1",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stub-key",
      },
      body: JSON.stringify({ model: "openrouter/test", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    const payload = (await response.json()) as { id: string };
    expect(payload.id).toBe("resp_1");
  });

  it("streams SSE responses from backend proxy", async () => {
    const backendPort = await getFreePort();
    const backendServer = http.createServer((_, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"id":"chunk_1","model":"openrouter/test"}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenRouterProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/api/v1",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/test", stream: true, messages: [] }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
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

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}
