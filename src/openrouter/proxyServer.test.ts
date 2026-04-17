import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  LOCAL_PROXY_LISTEN_HOST,
  sanitizeWebSocketCloseCode,
  startElevenlabsProxyServer,
  startFalProxyServer,
  startOpenAiProxyServer,
  startGoogleAiProxyServer,
  startJinaProxyServer,
  startMoonshotProxyServer,
  startOpenRouterProxyServer,
  startRunwayProxyServer,
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
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);
    await waitForListening(relayServer);
    expect(relayServer.address()).toMatchObject({ address: LOCAL_PROXY_LISTEN_HOST, port: relayPort });

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer stub-key",
        },
        body: JSON.stringify({ model: "openrouter/test", messages: [{ role: "user", content: "hi" }] }),
      }
    );

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
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openrouter/test", stream: true, messages: [] }),
      }
    );
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
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/openrouter/api/v1/chat/completions`,
      {
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
      }
    );

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
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${relayPort}/provider-proxy/openrouter/api/v1/chat/completions`,
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

  it("keeps the legacy /api/v1 OpenRouter local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenRouterProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openrouter/test", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/openrouter/chat/completions");
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
      pathPrefix: "/provider-proxy/google-ai",
      backendPathPrefix: "/api/v1/relays/google-ai",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/google-ai/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?alt=sse&key=attacker`,
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

  it("keeps the legacy root Google AI local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startGoogleAiProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/google-ai",
      backendPathPrefix: "/api/v1/relays/google-ai",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/v1beta/models/test:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/google-ai/v1beta/models/test:generateContent");
  });
});

describe("startElevenlabsProxyServer", () => {
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

  it("forwards ElevenLabs-compatible requests to backend proxy without trusting the client secret", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let requestBody = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ audio_base64: "ZmFrZS1hdWRpby1ieXRlcw==" }));
      })();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startElevenlabsProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/elevenlabs",
      backendPathPrefix: "/api/v1/relays/elevenlabs",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/elevenlabs/v1/text-to-speech/voice_123`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "xi-api-key": "stub-elevenlabs-key",
        },
        body: JSON.stringify({
          model_id: "eleven_multilingual_v2",
          text: "Hello from ElevenLabs",
        }),
      }
    );

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/elevenlabs/v1/text-to-speech/voice_123");
    expect(requestBody).toContain("eleven_multilingual_v2");
    await expect(response.json()).resolves.toMatchObject({
      audio_base64: "ZmFrZS1hdWRpby1ieXRlcw==",
    });
  });

  it("keeps the legacy /v1 ElevenLabs local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startElevenlabsProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/elevenlabs",
      backendPathPrefix: "/api/v1/relays/elevenlabs",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/models`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/elevenlabs/models");
  });
});

describe("startRunwayProxyServer", () => {
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

  it("forwards Runway-compatible requests to backend proxy without trusting the client bearer token", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let requestBody = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "task_123", status: "PENDING" }));
      })();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startRunwayProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/runway",
      backendPathPrefix: "/api/v1/relays/runway",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/provider-proxy/runway/v1/image_to_video`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stub-runway-key",
      },
      body: JSON.stringify({
        model: "gen4.5",
        promptText: "A slow camera orbit",
      }),
    });

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/runway/v1/image_to_video");
    expect(requestBody).toContain("gen4.5");
    await expect(response.json()).resolves.toMatchObject({
      id: "task_123",
      status: "PENDING",
    });
  });

  it("keeps the legacy /v1 Runway local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startRunwayProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/runway",
      backendPathPrefix: "/api/v1/relays/runway",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/tasks/task_123`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/runway/tasks/task_123");
  });
});

describe("startFalProxyServer", () => {
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

  it("forwards fal-compatible requests to backend proxy without trusting the client auth header", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let forwardedTargetHeader: string | null = null;
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      forwardedTargetHeader = req.headers["x-fal-target-url"]
        ? String(req.headers["x-fal-target-url"])
        : null;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ request_id: "fal_req_1", status: "IN_QUEUE" }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startFalProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/fal",
      backendPathPrefix: "/api/v1/relays/fal",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/provider-proxy/fal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Key stub-fal-key",
        "x-fal-target-url": "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video",
      },
      body: JSON.stringify({ prompt: "A premium product reveal" }),
    });

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/fal/");
    expect(forwardedTargetHeader).toBe(
      "https://queue.fal.run/bytedance/seedance-2.0/fast/text-to-video"
    );
    await expect(response.json()).resolves.toMatchObject({
      request_id: "fal_req_1",
      status: "IN_QUEUE",
    });
  });
});

describe("startOpenAiProxyServer", () => {
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

  it("forwards OpenAI-compatible requests to backend proxy without trusting the client bearer token", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let requestBody = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "resp_123",
            model: "gpt-5.4",
            output: [],
          })
        );
      })();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenAiProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/openai",
      backendPathPrefix: "/api/v1/relays/openai",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/provider-proxy/openai/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stub-openai-key",
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    });

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/openai/v1/responses");
    expect(requestBody).toContain(`"model":"gpt-5.4"`);
    await expect(response.json()).resolves.toMatchObject({
      id: "resp_123",
      model: "gpt-5.4",
    });
  });

  it("keeps the legacy /v1 OpenAI local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenAiProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/openai",
      backendPathPrefix: "/api/v1/relays/openai",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/openai/responses");
  });

  it("proxies OpenAI websocket responses through the local relay", async () => {
    const backendPort = await getFreePort();
    let backendAuthHeader: string | null = null;
    let backendPath = "";
    const backendWss = new WebSocketServer({ noServer: true });
    const backendServer = http.createServer();
    backendServer.on("upgrade", (req, socket, head) => {
      backendAuthHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
      backendPath = req.url ?? "";
      backendWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data) => {
          ws.send(
            JSON.stringify({
              type: "response.completed",
              echo: decodeWsData(data),
            })
          );
          ws.close(1000, "ok");
        });
      });
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startOpenAiProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/openai",
      backendPathPrefix: "/api/v1/relays/openai",
    });
    servers.push(relayServer);

    const client = new WebSocket(`ws://127.0.0.1:${relayPort}/provider-proxy/openai/v1/responses`);
    const message = await new Promise<string>((resolve, reject) => {
      client.once("open", () => {
        client.send(JSON.stringify({ type: "response.create", response: { model: "gpt-5.4" } }));
      });
      client.once("message", (data) => resolve(decodeWsData(data)));
      client.once("error", reject);
    });

    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(backendPath).toBe("/api/v1/relays/openai/v1/responses");
    expect(JSON.parse(message)).toMatchObject({
      type: "response.completed",
    });
    client.terminate();
    backendWss.close();
  });
});

describe("startJinaProxyServer", () => {
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

  it("forwards Jina-compatible requests to backend proxy without trusting the client bearer token", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let requestBody = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }], model: "jina-embeddings-v5-text-small" }));
      })();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startJinaProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/jina",
      backendPathPrefix: "/api/v1/relays/jina",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/provider-proxy/jina/v1/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stub-jina-key",
      },
      body: JSON.stringify({ model: "jina-embeddings-v5-text-small", input: ["hello"] }),
    });

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/jina/v1/embeddings");
    expect(requestBody).toContain("jina-embeddings-v5-text-small");
    await expect(response.json()).resolves.toMatchObject({
      data: [{ embedding: [0.1, 0.2] }],
      model: "jina-embeddings-v5-text-small",
    });
  });

  it("keeps the legacy /v1 Jina local alias working", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startJinaProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/jina",
      backendPathPrefix: "/api/v1/relays/jina",
    });
    servers.push(relayServer);

    const response = await fetch(`http://127.0.0.1:${relayPort}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "jina-embeddings-v5-text-small", input: ["hello"] }),
    });

    expect(response.status).toBe(200);
    expect(receivedPath).toBe("/api/v1/relays/jina/embeddings");
  });
});

describe("startMoonshotProxyServer", () => {
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

  it("forwards Moonshot-compatible requests to backend proxy without trusting the client bearer token", async () => {
    const backendPort = await getFreePort();
    let receivedPath = "";
    let backendAuthHeader: string | null = null;
    let requestBody = "";
    const backendServer = http.createServer((req, res) => {
      receivedPath = req.url ?? "";
      backendAuthHeader = req.headers.authorization ? String(req.headers.authorization) : null;
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        requestBody = Buffer.concat(chunks).toString("utf8");
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            model: "moonshot-v1-8k",
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          })
        );
      })();
    });
    await listen(backendServer, backendPort);
    servers.push(backendServer);

    const relayPort = await getFreePort();
    const relayServer = startMoonshotProxyServer({
      port: relayPort,
      backendBaseUrl: `http://127.0.0.1:${backendPort}`,
      relayToken: "relay-token",
      pathPrefix: "/provider-proxy/moonshot",
      backendPathPrefix: "/api/v1/relays/moonshot",
    });
    servers.push(relayServer);

    const response = await fetch(
      `http://127.0.0.1:${relayPort}/provider-proxy/moonshot/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer stub-moonshot-key",
        },
        body: JSON.stringify({ model: "moonshot-v1-8k", messages: [{ role: "user", content: "hi" }] }),
      }
    );

    expect(response.status).toBe(200);
    expect(backendAuthHeader).toBe("Bearer relay-token");
    expect(receivedPath).toBe("/api/v1/relays/moonshot/v1/chat/completions");
    expect(requestBody).toContain("moonshot-v1-8k");
    await expect(response.json()).resolves.toMatchObject({
      model: "moonshot-v1-8k",
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
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

function decodeWsData(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
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

describe("sanitizeWebSocketCloseCode", () => {
  it("passes through explicitly valid codes", () => {
    expect(sanitizeWebSocketCloseCode(1000)).toBe(1000);
    expect(sanitizeWebSocketCloseCode(1011)).toBe(1011);
    expect(sanitizeWebSocketCloseCode(3000)).toBe(3000);
    expect(sanitizeWebSocketCloseCode(4000)).toBe(4000);
    expect(sanitizeWebSocketCloseCode(4999)).toBe(4999);
  });

  it("drops reserved codes that must never be sent on the wire", () => {
    expect(sanitizeWebSocketCloseCode(1005)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(1006)).toBeUndefined();
  });

  it("drops codes outside the allowed ranges", () => {
    expect(sanitizeWebSocketCloseCode(1001)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(1015)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(2999)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(5000)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(0)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(-1)).toBeUndefined();
  });

  it("drops undefined and non-finite numbers", () => {
    expect(sanitizeWebSocketCloseCode(undefined)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(Number.NaN)).toBeUndefined();
    expect(sanitizeWebSocketCloseCode(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});
