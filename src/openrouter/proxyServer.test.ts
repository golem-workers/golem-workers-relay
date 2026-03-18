import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_PROXY_LISTEN_HOST,
  startGoogleAiProxyServer,
  startOpenRouterProxyServer,
} from "./proxyServer.js";

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
    const backendServer = http.createServer((req, res) => {
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
    await waitForListening(relayServer);
    expect(relayServer.address()).toMatchObject({ address: LOCAL_PROXY_LISTEN_HOST, port: relayPort });

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

  it("forwards multimodal audio JSON payloads and rewrites the openrouter model prefix", async () => {
    const backendPort = await getFreePort();
    let upstreamBody: unknown = null;
    const backendServer = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      })();
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
      body: JSON.stringify({
        model: "openrouter/openai/gpt-audio",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this." },
              {
                type: "input_audio",
                input_audio: {
                  data: Buffer.from("voice").toString("base64"),
                  format: "ogg",
                },
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toMatchObject({
      model: "openai/gpt-audio",
      messages: [
        {
          content: [
            { type: "text", text: "Transcribe this." },
            {
              type: "input_audio",
              input_audio: {
                format: "ogg",
              },
            },
          ],
        },
      ],
    });
  });

  it("stays alive when the client disconnects mid-stream", async () => {
    const backendPort = await getFreePort();
    const backendServer = http.createServer((_, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('data: {"id":"chunk_1"}\n\n');
      setTimeout(() => {
        res.write('data: {"id":"chunk_2"}\n\n');
        res.end();
      }, 50);
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

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${relayPort}/api/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
          res.once("error", () => resolve());
        }
      );
      req.once("error", reject);
      req.end(JSON.stringify({ model: "openrouter/test", stream: true, messages: [] }));
    });

    await sleep(100);

    const health = await fetch(`http://127.0.0.1:${relayPort}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true, status: "ok" });
  });
});

describe("startGoogleAiProxyServer", () => {
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

  it("forwards Gemini requests to backend proxy without rewriting path or key query", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startGoogleAiProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/",
      backendPathPrefix: "/api/v1/relays/google-ai",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?alt=sse&key=attacker`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": "client-key",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Search web" }] }],
          tools: [{ google_search: {} }],
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe(
      "/api/v1/relays/google-ai/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?alt=sse&key=attacker"
    );
    await expect(response.json()).resolves.toMatchObject({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
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

async function waitForListening(server: http.Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve) => {
    server.once("listening", () => resolve());
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
