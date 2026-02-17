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

