import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GatewayClient } from "./gatewayClient.js";

function startServer(handler: (ws: import("ws").WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => handler(ws));
  const addr = wss.address();
  if (typeof addr !== "object" || !addr) throw new Error("no addr");
  return { wss, port: addr.port };
}

describe("GatewayClient", () => {
  it("connects with connect.challenge then connect and consumes hello-ok", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
              },
            })
          );
        }
      });
    });

    const client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token: "t" });
    await client.start();
    expect(client.isReady()).toBe(true);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("accepts hello-ok auth without deviceToken", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let observedHello: { auth?: { role?: string; scopes?: string[]; deviceToken?: string } } | null = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
                auth: {
                  role: "operator",
                  scopes: ["operator.admin"],
                },
              },
            })
          );
        }
      });
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onHelloOk: (hello) => {
        observedHello = hello;
      },
    });
    await client.start();

    expect(client.isReady()).toBe(true);
    expect(observedHello?.auth).toEqual({
      role: "operator",
      scopes: ["operator.admin"],
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("re-sends connect with nonce when challenge arrives after the first connect", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const connectNonces: Array<string | null> = [];
    const { wss, port } = startServer((ws) => {
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as {
          type: string;
          id: string;
          method: string;
          params?: { device?: { nonce?: string } };
        };
        if (frame.type !== "req" || frame.method !== "connect") {
          return;
        }

        connectNonces.push(frame.params?.device?.nonce ?? null);
        if (connectNonces.length === 1) {
          ws.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "nonce-after-first-connect", ts: 1 },
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 3,
              policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
              server: { version: "x", connId: "c" },
              snapshot: {},
              features: { methods: [], events: [] },
            },
          })
        );
      });
    });

    const client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token: "t" });
    await client.start();
    expect(client.isReady()).toBe(true);
    expect(connectNonces).toEqual([null, "nonce-after-first-connect"]);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("retries when websocket opens but hello-ok never arrives", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let connections = 0;
    const { wss, port } = startServer((ws) => {
      connections += 1;
      const connectionNo = connections;
      if (connectionNo < 3) {
        return;
      }

      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce3", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
              },
            })
          );
        }
      });
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      connectReadyTimeoutMs: 300,
      startupRetryDelayMs: 25,
      startupMaxAttempts: 3,
    });

    await Promise.all([client.start(), delayTerminateOnNextSockets(client, 2, 80)]);
    expect(client.isReady()).toBe(true);
    expect(connections).toBe(3);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("fails after the configured number of handshake retries", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let connections = 0;
    const { wss, port } = startServer(() => {
      connections += 1;
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      connectReadyTimeoutMs: 300,
      startupRetryDelayMs: 25,
      startupMaxAttempts: 2,
    });

    await expect(client.start()).rejects.toThrow("Gateway connect handshake timed out after 300ms");
    expect(connections).toBe(2);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("retries when websocket upgrade handshake stalls before open", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let upgrades = 0;
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      upgrades += 1;
      if (upgrades < 3) {
        setTimeout(() => {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }, 120);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce3", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
              },
            })
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${addr.port}`,
      token: "t",
      websocketHandshakeTimeoutMs: 50,
      startupRetryDelayMs: 25,
      startupMaxAttempts: 3,
    });

    await client.start();
    expect(client.isReady()).toBe(true);
    expect(upgrades).toBe(3);

    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it("emits connection state changes for disconnect and reconnect", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const observed: Array<{ connected: boolean; reason?: string }> = [];
    let firstSocket = true;
    const { wss, port } = startServer((ws) => {
      const currentIsFirst = firstSocket;
      firstSocket = false;
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
              },
            })
          );
          if (currentIsFirst) {
            setTimeout(() => ws.close(4001, "lost"), 10);
          }
        }
      });
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onConnectionStateChange: (state) => observed.push({ connected: state.connected, reason: state.reason }),
    });
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 1800));

    expect(observed.some((entry) => entry.connected)).toBe(true);
    expect(observed.some((entry) => entry.connected === false)).toBe(true);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("uses the configured tick timeout multiplier before closing the socket", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const observed: Array<{ connected: boolean; reason?: string }> = [];
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string };
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 1000, maxPayload: 1, maxBufferedBytes: 1 },
                server: { version: "x", connId: "c" },
                snapshot: {},
                features: { methods: [], events: [] },
              },
            })
          );
        }
      });
    });

    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      tickTimeoutMultiplier: 3,
      onConnectionStateChange: (state) => observed.push({ connected: state.connected, reason: state.reason }),
    });
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(observed.some((entry) => entry.connected === false)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(observed.some((entry) => entry.connected === false && entry.reason?.includes("tick timeout"))).toBe(true);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });
});

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data) && data.every((x) => Buffer.isBuffer(x))) {
    return Buffer.concat(data).toString("utf8");
  }
  return "";
}

async function delayTerminateOnNextSockets(client: GatewayClient, count: number, delayMs: number): Promise<void> {
  const seen = new Set<WebSocket>();
  const deadline = Date.now() + 2_000;

  while (seen.size < count) {
    const ws = getClientSocket(client);
    if (ws && !seen.has(ws)) {
      seen.add(ws);
      const originalTerminate = ws.terminate.bind(ws);
      ws.terminate = (() => {
        setTimeout(() => originalTerminate(), delayMs);
      }) as typeof ws.terminate;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting to patch ${count} sockets`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function getClientSocket(client: GatewayClient): WebSocket | null {
  return (client as unknown as { ws?: WebSocket | null }).ws ?? null;
}

