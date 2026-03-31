import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
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
      connectReadyTimeoutMs: 150,
      startupRetryDelayMs: 25,
      startupMaxAttempts: 3,
    });

    await client.start();
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
      connectReadyTimeoutMs: 150,
      startupRetryDelayMs: 25,
      startupMaxAttempts: 2,
    });

    await expect(client.start()).rejects.toThrow("Gateway connect handshake timed out after 150ms");
    expect(connections).toBe(2);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
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

