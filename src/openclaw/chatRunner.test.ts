import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "./gatewayClient.js";
import { ChatRunner, applyTransportDeliveryInstructions, isOpenclawSlashCommand } from "./chatRunner.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function startServer(handler: (ws: import("ws").WebSocket) => void) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => handler(ws));
  const addr = wss.address();
  if (typeof addr !== "object" || !addr) throw new Error("no addr");
  return { wss, port: addr.port };
}

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

function maybeHandleSessionsUsage(
  ws: import("ws").WebSocket,
  frame: { type: string; id: string; method: string; params?: unknown }
): boolean {
  if (frame.type === "req" && frame.method === "sessions.usage") {
    ws.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: {
          source: "sessions.usage",
          updatedAt: 123456,
          totals: { input: 20, output: 7, totalTokens: 27, totalCost: 0.002 },
          aggregates: {
            byModel: [
              {
                provider: "moonshot",
                model: "kimi-k2.5",
                count: 2,
                totals: { input: 20, output: 7, totalTokens: 27, totalCost: 0.002 },
              },
            ],
          },
        },
      })
    );
    return true;
  }
  return false;
}

describe("ChatRunner", () => {
  it("maps chat final event with message to reply", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          const sessionKey = (() => {
            if (!frame.params || typeof frame.params !== "object") return "unknown";
            const value = (frame.params as Record<string, unknown>).sessionKey;
            return typeof value === "string" ? value : "unknown";
          })();
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                  message: { text: "ok" },
                  usage: { inputTokens: 120, outputTokens: 30, model: "moonshot/kimi-k2.5" },
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_1",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_1",
    });
    expect(runner.getRunTrace("run_1")).toEqual({ backendMessageId: "task_1" });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("maps aborted chat event with user-facing message to reply", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_aborted_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          const sessionKey = (() => {
            if (!frame.params || typeof frame.params !== "object") return "unknown";
            const value = (frame.params as Record<string, unknown>).sessionKey;
            return typeof value === "string" ? value : "unknown";
          })();
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "aborted",
                  message: { text: "partial but useful" },
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_aborted_1",
      sessionKey: "tg:123:srv_1",
      messageText: "hi",
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      outcome: "reply",
      reply: {
        runId: "run_aborted_1",
        message: { text: "partial but useful" },
      },
    });
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_aborted_1",
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("passes supplied relay origin route without appending file delivery instructions", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";
    let sentParams: Record<string, unknown> = {};

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentParams = params;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_tg_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "tg:123:srv_1", seq: 1, state: "final", message: { text: "ok" } },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_tg_1",
      sessionKey: "tg:123:srv_1",
      messageText: "Please prepare a report",
      originRoute: {
        originatingChannel: "relay-channel",
        originatingTo: "telegram:123",
      },
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(sentMessage).toBe("Please prepare a report");
    expect(sentMessage).not.toContain("[Telegram plugin note]");
    expect(sentMessage).not.toContain("[[media:relative/path.ext]]");
    expect(sentParams).not.toHaveProperty("deliver");
    expect(sentParams).toHaveProperty("originatingChannel", "relay-channel");
    expect(sentParams).toHaveProperty("originatingTo", "telegram:123");
    expect(sentParams).not.toHaveProperty("originatingAccountId");
    expect(sentParams).not.toHaveProperty("originatingThreadId");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("keeps intermediate chat events in reply payload", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_with_delta_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s1", seq: 1, state: "delta", message: { text: "ping" } },
              })
            );
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s1", seq: 2, state: "final", message: { text: "pong" } },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_with_delta_1",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(Array.isArray(result.reply.openclawEvents)).toBe(true);
    expect(result.reply.openclawEvents).toHaveLength(2);
    expect(result.reply.openclawEvents?.[0]?.state).toBe("delta");
    expect(result.reply.openclawEvents?.[1]?.state).toBe("final");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not inject [[media:...]] directives for relay_channel_v2", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-native-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await fs.mkdir(path.join(stateDir, "workspace", "files"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "workspace", "files", "report.pdf"), "pdf");
    let sentMessage = "";
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_tg_v2_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "tg:123:srv_1",
                  seq: 1,
                  state: "final",
                  message: { text: "done\n\n[[media:files/report.pdf]]" },
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_tg_v2_1",
      sessionKey: "tg:123:srv_1",
      messageText: "Please prepare a report",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(sentMessage).toBe("Please prepare a report");
    expect(sentMessage).not.toContain("[Telegram plugin note]");
    expect(sentMessage).not.toContain("[[media:relative/path.ext]]");
    expect(sentMessage).not.toContain("MEDIA: relative/path.ext");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.artifacts).toBeUndefined();
    expect(result.reply.media).toBeUndefined();

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("uses the latest delta message when final arrives without message", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_final_without_message";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s1",
                  seq: 1,
                  state: "delta",
                  message: { role: "assistant", content: [{ type: "text", text: "draft answer" }] },
                },
              })
            );
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s1",
                  seq: 2,
                  state: "final",
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_final_without_message",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "draft answer" }],
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("waits for a late final reply after an empty final event", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_empty_final_then_reply";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s1",
                  seq: 1,
                  state: "final",
                },
              })
            );
          }, 10);
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s1",
                  seq: 2,
                  state: "final",
                  message: { role: "assistant", content: [{ type: "text", text: "continued answer" }] },
                },
              })
            );
          }, 50);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_empty_final_then_reply",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "continued answer" }],
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("returns an error when final arrives without any user-facing message", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_no_message";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s1",
                  seq: 1,
                  state: "final",
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_no_message",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") throw new Error("expected error");
    expect(result.error.code).toBe("NO_MESSAGE");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not request sessions usage snapshots during chat", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    const sessionsUsageParamsSeen: unknown[] = [];

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (frame.type === "req" && frame.method === "sessions.usage") {
          sessionsUsageParamsSeen.push(frame.params);
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                updatedAt: 123456,
                startDate: "2026-02-23",
                endDate: "2026-02-23",
                totals: { input: 20, output: 7, totalTokens: 27, totalCost: 0.002 },
                aggregates: {
                  byModel: [
                    {
                      provider: "moonshot",
                      model: "kimi-k2.5",
                      count: 2,
                      totals: { input: 20, output: 7, totalTokens: 27, totalCost: 0.002 },
                    },
                  ],
                },
              },
            })
          );
          return;
        }
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: [
                    "chat.send",
                    "sessions.usage",
                  ],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type !== "req") return;
        if (frame.method === "chat.send") {
          const runId = "run_snapshot_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-snapshot",
                  seq: 1,
                  state: "final",
                  message: { text: "ok" },
                },
              })
            );
          }, 10);
          return;
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_snapshot_1",
      sessionKey: "s-snapshot",
      messageText: "hi",
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe("reply");
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_snapshot_1",
    });
    expect(sessionsUsageParamsSeen).toEqual([]);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not depend on sessions.usage availability", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let chatSendCalls = 0;

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (frame.type === "req" && frame.method === "sessions.usage") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "METHOD_NOT_FOUND",
                message: "Unknown method: sessions.usage",
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type !== "req") return;
        if (frame.method === "chat.send") {
          chatSendCalls += 1;
          const runId = "run_snapshot_2";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-snapshot",
                  seq: 1,
                  state: "final",
                  message: { text: "ok" },
                },
              })
            );
          }, 10);
          return;
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_snapshot_2",
      sessionKey: "s-snapshot",
      messageText: "hi",
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({
      outcome: "reply",
    });
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_snapshot_2",
    });
    expect(chatSendCalls).toBe(1);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("works even when sessions.usage is not advertised", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type !== "req") return;
        if (frame.method === "chat.send") {
          const runId = "run_snapshot_not_advertised";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-not-advertised",
                  seq: 1,
                  state: "final",
                  message: { text: "ok" },
                },
              })
            );
          }, 10);
          return;
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_snapshot_not_advertised",
      sessionKey: "s-not-advertised",
      messageText: "hi",
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe("reply");
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_snapshot_not_advertised",
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("works even when hello features are missing", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          // Intentionally omit hello.features to emulate older gateway shape.
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
              },
            })
          );
          return;
        }
        if (frame.type !== "req") return;
        if (frame.method === "chat.send") {
          const runId = "run_snapshot_legacy";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-legacy",
                  seq: 1,
                  state: "final",
                  message: { text: "ok" },
                },
              })
            );
          }, 10);
          return;
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_snapshot_legacy",
      sessionKey: "s-legacy",
      messageText: "hi",
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe("reply");
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_snapshot_legacy",
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("transcribes audio and appends transcript before chat.send", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_audio";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-audio", seq: 1, state: "final", message: { text: "ok" } },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      transcription: {
        baseUrl: "http://127.0.0.1:18080/provider-proxy/openrouter/api/v1",
        model: "openrouter/test-audio",
        timeoutMs: 1000,
      },
      transcribeAudio: vi.fn().mockResolvedValue("hello from voice"),
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_audio",
      sessionKey: "s-audio",
      messageText: "User said:",
      media: [
        {
          type: "audio",
          dataB64: Buffer.from("audio", "utf8").toString("base64"),
          contentType: "audio/ogg",
          fileName: "voice.ogg",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(sentMessage).toContain("User said:");
    expect(sentMessage).toContain("[Voice transcript]");
    expect(sentMessage).toContain("hello from voice");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("fails the task when transcription fails instead of sending raw voice placeholder to the model", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_audio_fallback";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-audio", seq: 1, state: "final", message: { text: "ok" } },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      transcription: {
        baseUrl: "http://127.0.0.1:18080/provider-proxy/openrouter/api/v1",
        model: "openrouter/test-audio",
        timeoutMs: 1000,
      },
      transcribeAudio: vi.fn().mockRejectedValue(new Error("stt down")),
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_audio_fallback",
      sessionKey: "s-audio",
      messageText: "keep me",
      media: [
        {
          type: "audio",
          dataB64: Buffer.from("audio", "utf8").toString("base64"),
          contentType: "audio/ogg",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("error");
    expect(result).toEqual({
      outcome: "error",
      error: {
        code: "VOICE_TRANSCRIPTION_FAILED",
        message: "Voice message could not be transcribed, so it was not sent to the model. stt down",
      },
    });
    expect(sentMessage).toBe("");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  }, 10_000);

  it("passes OpenRouter STT settings to injected transcriber", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";
    const transcribeAudio = vi.fn().mockResolvedValue("voice text");

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_audio_skip";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-audio", seq: 1, state: "final", message: { text: "ok" } },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      transcription: {
        baseUrl: "http://127.0.0.1:18080/custom-proxy",
        model: "gpt-4o-transcribe",
        timeoutMs: 1000,
      },
      transcribeAudio,
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_audio_skip",
      sessionKey: "s-audio",
      messageText: "keep original",
      media: [
        {
          type: "audio",
          dataB64: Buffer.from("audio", "utf8").toString("base64"),
          contentType: "audio/ogg",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://127.0.0.1:18080/custom-proxy",
        model: "gpt-4o-transcribe",
      })
    );
    expect(sentMessage).toContain("[Voice transcript]");
    expect(sentMessage).toContain("voice text");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("uses the OpenAI transcriber defaults when no STT config override is provided", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    const transcribeAudio = vi.fn().mockResolvedValue("voice text");
    let sentMessage = "";

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_openai";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-openai", seq: 1, state: "final", message: { text: "ok" } },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      transcribeAudio,
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_openai_transcribe",
      sessionKey: "s-openai",
      messageText: "from voice:",
      media: [
        {
          type: "audio",
          dataB64: Buffer.from("audio", "utf8").toString("base64"),
          contentType: "audio/ogg",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "http://localhost:3000/api/v1/relays/openai",
        model: "gpt-4o-transcribe",
      })
    );
    expect(sentMessage).toContain("[Voice transcript]");
    expect(sentMessage).toContain("voice text");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("sends images to chat.send as multimodal image_url content", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage: unknown = null;

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_image_direct";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-image",
                  seq: 1,
                  state: "final",
                  message: { text: "vision ok" },
                },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_image_direct",
      sessionKey: "s-image",
      messageText: "what is in this image?",
      media: [
        {
          type: "image",
          dataB64: ONE_BY_ONE_PNG_B64,
          contentType: "image/png",
          fileName: "vision.png",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(sentMessage).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is in this image?" },
        {
          type: "image_url",
        },
      ],
    });
    const sentContent = (sentMessage as { content: Array<{ type: string; image_url?: { url?: string } }> }).content;
    expect(sentContent[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("falls back to uploaded files when gateway rejects multimodal payloads", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-image-fallback-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const uploadsDir = path.join(stateDir, "workspace", "files");
    let chatSendCalls = 0;
    const sentMessages: unknown[] = [];

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          chatSendCalls += 1;
          sentMessages.push(((frame.params ?? {}) as Record<string, unknown>).message);
          if (chatSendCalls === 1) {
            ws.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: false,
                error: {
                  code: "VALIDATION_ERROR",
                  message: "Invalid message payload",
                },
              }),
            );
            return;
          }
          const runId = "run_image_fallback";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey: "s-image-fallback",
                  seq: 1,
                  state: "final",
                  message: { text: "fallback ok" },
                },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_image_fallback",
      sessionKey: "s-image-fallback",
      messageText: "",
      media: [
        {
          type: "image",
          dataB64: ONE_BY_ONE_PNG_B64,
          contentType: "image/png",
          fileName: "vision.png",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(chatSendCalls).toBe(2);
    expect(sentMessages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "[image]" },
        {
          type: "image_url",
        },
      ],
    });
    const fallbackContent = (
      sentMessages[0] as { content: Array<{ type: string; image_url?: { url?: string } }> }
    ).content;
    expect(fallbackContent[1]?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(typeof sentMessages[1]).toBe("string");
    expect(sentMessages[1]).toMatch(/\[image\]/);
    expect(sentMessages[1]).toMatch(/File uploaded to:/);
    const uploadedEntries = await fs.readdir(uploadsDir);
    expect(uploadedEntries.some((name) => name.endsWith("-vision.png"))).toBe(true);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("stores uploaded files, appends file paths, and rotates old files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-uploads-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const uploadsDir = path.join(stateDir, "workspace", "files");
    await fs.mkdir(uploadsDir, { recursive: true });

    const oldFilePath = path.join(uploadsDir, "old-file.txt");
    await fs.writeFile(oldFilePath, "old", "utf8");
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldFilePath, oldDate, oldDate);

    let sentMessage = "";
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = typeof params.message === "string" ? params.message : "";
          const runId = "run_file_upload";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-files", seq: 1, state: "final", message: { text: "ok" } },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_file_upload",
      sessionKey: "s-files",
      messageText: "Process uploaded files",
      media: [
        {
          type: "file",
          dataB64: Buffer.from("first-file", "utf8").toString("base64"),
          contentType: "text/plain",
          fileName: "first.txt",
        },
        {
          type: "file",
          dataB64: Buffer.from("second-file", "utf8").toString("base64"),
          contentType: "text/plain",
          fileName: "second.txt",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");

    const uploadedEntries = await fs.readdir(uploadsDir);
    expect(uploadedEntries.some((name) => name.includes("old-file.txt"))).toBe(false);
    expect(uploadedEntries.filter((name) => name.endsWith("-first.txt")).length).toBe(1);
    expect(uploadedEntries.filter((name) => name.endsWith("-second.txt")).length).toBe(1);
    const uploadedLines = sentMessage.split("\n").filter((line) => line.startsWith("File uploaded to: "));
    expect(uploadedLines).toHaveLength(2);
    expect(uploadedLines[0]).toContain(path.join("workspace", "files"));
    expect(uploadedLines[1]).toContain(path.join("workspace", "files"));

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("stores uploaded videos and sends the full file path to chat.send", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-video-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const uploadsDir = path.join(stateDir, "workspace", "files");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessage = params.message;
          const runId = "run_video_upload";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey: "s-video", seq: 1, state: "final", message: { text: "ok" } },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_video_upload",
      sessionKey: "s-video",
      messageText: "Inspect the uploaded video",
      media: [
        {
          type: "video",
          dataB64: Buffer.from("fake-mp4-payload", "utf8").toString("base64"),
          contentType: "video/mp4",
          fileName: "clip.mp4",
        },
      ],
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    expect(typeof sentMessage).toBe("string");
    expect(sentMessage).toMatch(/Inspect the uploaded video/);
    expect(sentMessage).toMatch(/File uploaded to:/);
    expect(sentMessage).not.toMatch(/Only the first preview frame/);

    const uploadedEntries = await fs.readdir(uploadsDir);
    expect(uploadedEntries.filter((name) => name.endsWith("-clip.mp4")).length).toBe(1);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("attaches MEDIA files from the current reply", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    await fs.mkdir(path.join(workspaceRoot, "avatars"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "avatars", "klava.svg"), "<svg/>", "utf8");

    const sessionKey = "tg:449:server";

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_1";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "text",
                        text: "Here you go.\n\n[[media:avatars/klava.svg]]\n\n[[reply_to_current]]",
                      },
                    ],
                  },
                },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_1",
      sessionKey,
      messageText: "hi",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.artifacts).toBeUndefined();
    expect(result.reply.media).toBeUndefined();

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not recover [[media:...]] from the current session transcript when gateway final drops the directive", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(workspaceRoot, "output"), { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "output", "golem_awake.mp4"), "video", "utf8");

    const sessionKey = "tg:449:server";
    const sessionId = "sess-transcript-media";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_media";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            void (async () => {
              await fs.writeFile(
                sessionFile,
                [
                  JSON.stringify({
                    type: "message",
                    message:
                      typeof sentMessage === "string"
                        ? {
                            role: "user",
                            content:
                              "System: [2026-03-21 16:40:33 UTC] Exec completed (plaid-sa, code 0) :: done\n\n" +
                              sentMessage,
                          }
                        : sentMessage,
                  }),
                  JSON.stringify({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "Here is your video.\n\n[[media:output/golem_awake.mp4]]",
                        },
                      ],
                    },
                  }),
                ].join("\n") + "\n",
                "utf8"
              );
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey,
                    seq: 1,
                    state: "final",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "Here is your video." }],
                    },
                  },
                })
              );
            })();
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transcript_media",
      sessionKey,
      messageText: "send me the video",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.artifacts).toBeUndefined();
    expect(JSON.stringify(result.reply.message)).not.toContain("[[media:output/golem_awake.mp4]]");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not use divergent transcript text as a legacy artifact fallback", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-artifacts-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(workspaceRoot, "proofs"), { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "proofs", "identity.md"), "# identity\n", "utf8");

    const sessionKey = "tg:449:server";
    const sessionId = "sess-transcript-artifacts";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_artifacts";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            void (async () => {
              await fs.writeFile(
                sessionFile,
                [
                  JSON.stringify({
                    type: "message",
                    message:
                      typeof sentMessage === "string"
                        ? {
                            role: "user",
                            content: sentMessage,
                          }
                        : sentMessage,
                  }),
                  JSON.stringify({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [
                        {
                          type: "text",
                          text: "I prepared the file and attached it below.\n\n[[media:proofs/identity.md]]",
                        },
                      ],
                    },
                  }),
                ].join("\n") + "\n",
                "utf8"
              );
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey,
                    seq: 1,
                    state: "final",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "The file is ready." }],
                    },
                  },
                })
              );
            })();
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transcript_artifacts",
      sessionKey,
      messageText: "send me any file",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.artifacts).toBeUndefined();
    expect(JSON.stringify(result.reply.message)).not.toContain("[[media:proofs/identity.md]]");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("uses the current session transcript reply when final arrives without a message", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-final-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "s-transcript-final";
    const sessionId = "sess-transcript-final";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_final";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            void (async () => {
              await fs.writeFile(
                sessionFile,
                [
                  JSON.stringify({
                    type: "message",
                    message:
                      typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                  }),
                  JSON.stringify({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "Transcript only answer" }],
                    },
                  }),
                ].join("\n") + "\n",
                "utf8"
              );
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey,
                    seq: 1,
                    state: "final",
                  },
                })
              );
            })();
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transcript_final",
      sessionKey,
      messageText: "hi",
      timeoutMs: 1500,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Transcript only answer" }],
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not treat transcript assistant tool activity as the final reply", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-tool-activity-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "s-transcript-tool-activity";
    const sessionId = "sess-transcript-tool-activity";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_tool_activity";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            void fs.writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Сейчас быстро найду прошлый рацион." },
                      { type: "toolCall", name: "read", arguments: { path: "dasha_ration_excel.csv" } },
                    ],
                  },
                }),
              ].join("\n") + "\n",
              "utf8"
            );
          }, 10);
          setTimeout(() => {
            void fs.writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [
                      { type: "text", text: "Сейчас быстро найду прошлый рацион." },
                      { type: "toolCall", name: "read", arguments: { path: "dasha_ration_excel.csv" } },
                    ],
                  },
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Готово — обновила оба файла.\n\n[[media:dasha_ration_excel.csv]]" }],
                  },
                }),
              ].join("\n") + "\n",
              "utf8"
            );
          }, 350);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transcript_tool_activity",
      sessionKey,
      messageText: "update ration",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 3_000,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(JSON.stringify(result.reply.message)).toContain("Готово");
    expect(JSON.stringify(result.reply.message)).not.toContain("Сейчас быстро найду");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("waits for relay-backed session state before recovering a final transcript-only reply", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-final-delayed-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "tg:7278830001:delayed-final";
    const sessionId = "sess-transcript-final-delayed";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_final_delayed";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                },
              })
            );
          }, 20);
          setTimeout(() => {
            void (async () => {
              await fs.writeFile(
                path.join(sessionsDir, "sessions.json"),
                JSON.stringify({
                  [`agent:main:${sessionKey}`]: {
                    sessionId,
                    updatedAt: Date.now(),
                    sessionFile,
                  },
                }),
                "utf8"
              );
              await fs.writeFile(
                sessionFile,
                [
                  JSON.stringify({
                    type: "message",
                    message:
                      typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                  }),
                  JSON.stringify({
                    type: "message",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: "Recovered after delayed state flush" }],
                    },
                  }),
                ].join("\n") + "\n",
                "utf8"
              );
            })();
          }, 120);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transcript_final_delayed",
      sessionKey,
      messageText: "hi from relay-backed session",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 2_000,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Recovered after delayed state flush" }],
    });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("returns as soon as the current session transcript gets the reply even without a terminal event", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-timeout-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "s-transcript-timeout";
    const sessionId = "sess-transcript-timeout";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_timeout";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            void fs.writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Recovered before timeout" }],
                  },
                }),
              ].join("\n") + "\n",
              "utf8"
            );
          }, 50);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const startedAtMs = Date.now();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_transcript_timeout",
      sessionKey,
      messageText: "hi",
      timeoutMs: 5_000,
    });
    const elapsedMs = Date.now() - startedAtMs;
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Recovered before timeout" }],
    });
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_transcript_timeout",
    });
    expect(elapsedMs).toBeLessThan(2_000);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("matches late transcript replies for multipart telegram group prompts without a terminal event", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-multipart-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "tg:-5218477136:server";
    const sessionId = "sess-transcript-multipart";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_multipart";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            const sentText = (() => {
              if (typeof sentMessage === "string") {
                return sentMessage;
              }
              if (!sentMessage || typeof sentMessage !== "object") {
                return "";
              }
              const content = (sentMessage as { content?: unknown }).content;
              if (typeof content === "string") {
                return content;
              }
              if (!Array.isArray(content)) {
                return "";
              }
              return content
                .map((part) =>
                  part && typeof part === "object" && (part as { type?: unknown }).type === "text"
                    ? (part as { text?: unknown }).text
                    : null
                )
                .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
                .join("\n");
            })();
            const promptText = sentText.trim();
            const splitMarker = "\n\nProduction requirements:\n";
            const splitIndex = promptText.indexOf(splitMarker);
            const partOne =
              splitIndex > 0 ? promptText.slice(0, splitIndex).trim() : promptText.slice(0, Math.ceil(promptText.length / 2)).trim();
            const partTwo =
              splitIndex > 0 ? `Production requirements:\n${promptText.slice(splitIndex + splitMarker.length).trim()}` : promptText.slice(Math.ceil(promptText.length / 2)).trim();
            const transcriptUserText = [
              "Sender (untrusted metadata):",
              "```json",
              JSON.stringify({ label: "gateway-client", id: "gateway-client" }, null, 2),
              "```",
              "",
              "[2026-04-18 05:06 UTC] 0xbbx: [part 1/2]",
              partOne,
              "[2026-04-18 05:06 UTC] 0xbbx: [part 2/2]",
              partTwo,
            ].join("\n");
            void fs.writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: { role: "user", content: transcriptUserText },
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Late group-task blocker delivered" }],
                  },
                }),
              ].join("\n") + "\n",
              "utf8"
            );
          }, 50);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const startedAtMs = Date.now();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_transcript_multipart",
      sessionKey,
      messageText: [
        "Title: Golem Workers marketing video hook",
        "",
        "Instructions:",
        "Create one English 20-30s marketing video for golemworkers.com.",
        "",
        "Production requirements:",
        "- capture real browser footage of creating an agent in the product UI",
        "- keep the final render vertical 9:16",
        "- use fal.ai Kling 2.5 Turbo Pro and fal.ai MiniMax Speech-02 HD",
      ].join("\n"),
      deliverySystem: "relay_channel_v2",
      timeoutMs: 5_000,
    });
    const elapsedMs = Date.now() - startedAtMs;

    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Late group-task blocker delivered" }],
    });
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_transcript_multipart",
    });
    expect(elapsedMs).toBeLessThan(2_000);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("recovers the current session transcript reply after a terminal error event", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-transcript-error-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "s-transcript-error";
    const sessionId = "sess-transcript-error";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(sessionFile, "", "utf8");

    let sentMessage: unknown = null;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sentMessage = ((frame.params ?? {}) as Record<string, unknown>).message;
          const runId = "run_transcript_error";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "error",
                  errorMessage: "Chat error",
                },
              })
            );
          }, 10);
          setTimeout(() => {
            void fs.writeFile(
              sessionFile,
              [
                JSON.stringify({
                  type: "message",
                  message: typeof sentMessage === "string" ? { role: "user", content: sentMessage } : sentMessage,
                }),
                JSON.stringify({
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Recovered after error" }],
                  },
                }),
              ].join("\n") + "\n",
              "utf8"
            );
          }, 60);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const startedAtMs = Date.now();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_transcript_error",
      sessionKey,
      messageText: "hi",
      timeoutMs: 5_000,
    });
    const elapsedMs = Date.now() - startedAtMs;

    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Recovered after error" }],
    });
    expect(openclawMeta).toMatchObject({
      method: "chat.send",
      runId: "run_transcript_error",
    });
    expect(elapsedMs).toBeLessThan(2_000);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("does not resend stale MEDIA from earlier transcript history", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-stale-media-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(workspaceRoot, "avatars"), { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "avatars", "old.svg"), "<svg/>", "utf8");

    const sessionKey = "tg:449:server";
    const sessionId = "sess-stale";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId,
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Old file\nMEDIA: avatars/old.svg" }],
        },
      })}\n`,
      "utf8"
    );

    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: { methods: ["chat.send", "sessions.usage"], events: ["chat"] },
              },
            }),
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const runId = "run_no_media";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "just text, no file this time" }],
                  },
                },
              }),
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_no_stale_media",
      sessionKey,
      messageText: "hi again",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");
    if (result.outcome !== "reply") throw new Error("expected reply");
    expect(result.reply.media).toBeUndefined();

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("retries on injected SSE JSON 5xx error and succeeds", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    vi.spyOn(Math, "random").mockReturnValue(0);

    let sendCount = 0;
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sendCount += 1;
          const runId = `run_${sendCount}`;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          const sessionKey = (() => {
            if (!frame.params || typeof frame.params !== "object") return "unknown";
            const value = (frame.params as Record<string, unknown>).sessionKey;
            return typeof value === "string" ? value : "unknown";
          })();
          setTimeout(() => {
            if (sendCount === 1) {
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey,
                    seq: 1,
                    state: "error",
                    errorMessage:
                      "JSON error injected into SSE stream\n" +
                      '{\n  "error": {\n    "code": 500,\n    "message": "Internal error encountered.",\n    "status": "INTERNAL"\n  }\n}',
                  },
                })
              );
              return;
            }
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey, seq: 1, state: "final", message: { text: "ok" } },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      retry: { attempts: 2, baseDelayMs: [1], jitterMs: 0 },
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_1",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe("reply");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("retries transport interruptions in the same session with a recovery note", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let sendCount = 0;
    const sentMessages: unknown[] = [];
    const sentIdempotencyKeys: string[] = [];
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sendCount += 1;
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessages.push(params.message);
          sentIdempotencyKeys.push(typeof params.idempotencyKey === "string" ? params.idempotencyKey : "missing");
          const runId = `run_transport_${sendCount}`;
          const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "unknown";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            if (sendCount === 1) {
              ws.send(
                JSON.stringify({
                  type: "event",
                  event: "chat",
                  payload: {
                    runId,
                    sessionKey,
                    seq: 1,
                    state: "error",
                    errorMessage: "Network connection lost.",
                  },
                })
              );
              return;
            }
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: { runId, sessionKey, seq: 1, state: "final", message: { text: "recovered" } },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      retry: { attempts: 2, baseDelayMs: [1], jitterMs: 0 },
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transport_recovery",
      sessionKey: "s-transport",
      messageText: "finish the video",
      timeoutMs: 2000,
    });

    expect(result.outcome).toBe("reply");
    expect(sendCount).toBe(2);
    expect(sentMessages[0]).toBe("finish the video");
    expect(sentMessages[1]).toContain("finish the video");
    expect(sentMessages[1]).toContain("The previous attempt ended due to a network interruption");
    expect(sentMessages[1]).toContain("continue from existing artifacts if possible");
    expect(sentIdempotencyKeys).toEqual(["task_transport_recovery", "task_transport_recovery:transport-recovery:2"]);

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("fails active waiters immediately when the gateway disconnects mid-flight", async () => {
    const runner = new ChatRunner({ request: vi.fn() } as unknown as GatewayClient);
    const waitForFinal = (runner as unknown as { waitForFinal: (runId: string, timeoutMs: number) => Promise<unknown> })
      .waitForFinal.bind(runner);

    const pending = waitForFinal("run_disconnect_1", 10_000);
    runner.handleGatewayConnectionStateChange({
      connected: false,
      reason: "Gateway websocket closed (4001): gateway restart",
      observedAtMs: Date.now(),
    });

    await expect(pending).rejects.toThrow(
      "Gateway connection lost while waiting for run run_disconnect_1: Gateway websocket closed (4001): gateway restart"
    );
    expect((runner as unknown as { waitersByRunId: Map<string, unknown> }).waitersByRunId.size).toBe(0);
  });

  it("returns a normalized error after repeated transport interruptions", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let sendCount = 0;
    const sentMessages: unknown[] = [];
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          sendCount += 1;
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessages.push(params.message);
          const runId = `run_transport_fail_${sendCount}`;
          const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "unknown";
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "error",
                  errorMessage: "Network connection lost.",
                },
              })
            );
          }, 10);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      retry: { attempts: 3, baseDelayMs: [1, 1], jitterMs: 0 },
    });

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_transport_failure",
      sessionKey: "s-transport-fail",
      messageText: "finish the video",
      timeoutMs: 2500,
    });

    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") throw new Error("expected error");
    expect(result.error.message).toBe(
      "The agent lost network connectivity while running tools. We retried 3 times in the same session, but recovery did not succeed. Partial files may exist in the workspace."
    );
    expect(sendCount).toBe(3);
    expect(sentMessages[1]).toContain("The previous attempt ended due to a network interruption");
    expect(sentMessages[2]).toContain("The previous attempt ended due to a network interruption");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("releases the queue when a slash-command never emits a terminal event", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);

    let abortCalls = 0;
    const sentMessages: string[] = [];
    const { wss, port } = startServer((ws) => {
      ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce1", ts: 1 } }));
      ws.on("message", (data) => {
        const text = rawDataToString(data);
        const frame = JSON.parse(text) as { type: string; id: string; method: string; params?: unknown };
        if (maybeHandleSessionsUsage(ws, frame)) return;
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 3,
                policy: { tickIntervalMs: 5000 },
                features: {
                  methods: ["chat.send", "chat.abort", "sessions.usage"],
                  events: ["chat"],
                },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          sentMessages.push(typeof params.message === "string" ? params.message : JSON.stringify(params.message));
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId: "run_slash_timeout" } }));
          return;
        }
        if (frame.type === "req" && frame.method === "chat.abort") {
          abortCalls += 1;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { aborted: true } }));
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client, {
      retry: { attempts: 3, baseDelayMs: [1, 1], jitterMs: 0 },
    });

    await client.start();
    const { result, openclawMeta } = await runner.runChatTask({
      taskId: "task_slash_timeout",
      sessionKey: "tg:7278830001:cmo-test-slash",
      messageText: "/new",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 1000,
    });

    expect(sentMessages).toEqual(["/new"]);
    expect(abortCalls).toBe(1);
    expect(result.outcome).toBe("no_reply");
    if (result.outcome !== "no_reply") throw new Error("expected no_reply");
    expect(result.noReply).toMatchObject({
      reason: "slash_command_timeout_without_terminal_event",
      runId: "run_slash_timeout",
    });
    expect(openclawMeta).toEqual({ method: "chat.send", runId: "run_slash_timeout" });

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("startNewSessionForAll sends /new to known sessions and preserves files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-reset-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      '{"agent:main:s1":{"sessionFile":"a.jsonl"},"agent:main:s2":{"sessionFile":"b.jsonl"}}\n',
      "utf8"
    );
    await fs.writeFile(path.join(sessionsDir, "a.jsonl"), '{"event":"x"}\n', "utf8");
    await fs.writeFile(path.join(sessionsDir, "b.jsonl"), '{"event":"y"}\n', "utf8");
    const sentSessionKeys: string[] = [];

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
                policy: { tickIntervalMs: 5000 },
              },
            })
          );
          return;
        }
        if (frame.type === "req" && frame.method === "chat.send") {
          const params = (frame.params ?? {}) as Record<string, unknown>;
          const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "unknown";
          sentSessionKeys.push(sessionKey);
          const runId = `run_reset_${sessionKey}`;
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { runId } }));
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: "event",
                event: "chat",
                payload: {
                  runId,
                  sessionKey,
                  seq: 1,
                  state: "final",
                  message: { text: "started new session" },
                },
              })
            );
          }, 5);
        }
      });
    });

    let runner: ChatRunner | null = null;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: "t",
      onEvent: (evt) => runner?.handleEvent(evt),
    });
    runner = new ChatRunner(client);
    await client.start();
    const result = await runner.startNewSessionForAll();

    expect(result).toMatchObject({ reset: true, sessionsRotated: 2, sessionsFailed: 0 });
    expect(sentSessionKeys.sort()).toEqual(["s1", "s2"]);
    await expect(fs.access(path.join(sessionsDir, "a.jsonl"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(sessionsDir, "b.jsonl"))).resolves.toBeUndefined();
    const mapAfter = await fs.readFile(path.join(sessionsDir, "sessions.json"), "utf8");
    expect(mapAfter).toContain('"agent:main:s1"');
    expect(mapAfter).toContain('"agent:main:s2"');

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

describe("isOpenclawSlashCommand", () => {
  it("recognises bare slash-commands", () => {
    expect(isOpenclawSlashCommand("/new")).toBe(true);
    expect(isOpenclawSlashCommand("/compact")).toBe(true);
    expect(isOpenclawSlashCommand("/clear")).toBe(true);
    expect(isOpenclawSlashCommand("  /new  ")).toBe(true);
  });

  it("recognises slash-commands with arguments", () => {
    expect(isOpenclawSlashCommand("/new reset full context")).toBe(true);
    expect(isOpenclawSlashCommand("/compact -v")).toBe(true);
  });

  it("rejects non-slash text and edge cases", () => {
    expect(isOpenclawSlashCommand("hello world")).toBe(false);
    expect(isOpenclawSlashCommand("")).toBe(false);
    expect(isOpenclawSlashCommand("/")).toBe(false);
    expect(isOpenclawSlashCommand("/123bad")).toBe(false);
    expect(isOpenclawSlashCommand("prefix /new")).toBe(false);
  });

  it("does not recover relay_channel_v2 replies from a transcript text match without a gateway final", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-v2-transcript-stale-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionKey = "tg:449:server";
    const sessionFile = path.join(sessionsDir, "short-repeated.jsonl");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [`agent:main:${sessionKey}`]: {
          sessionId: "short-repeated",
          updatedAt: Date.now(),
          sessionFile,
        },
      }),
      "utf8"
    );
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "ау" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "stale answer" } }),
      ].join("\n") + "\n",
      "utf8"
    );

    const request = vi.fn().mockImplementation((method: string) => {
      if (method === "chat.send") {
        return Promise.resolve({ runId: "run_short_repeated" });
      }
      if (method === "chat.abort") {
        return Promise.resolve({ aborted: true });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const runner = new ChatRunner({ request } as never, {
      retry: { attempts: 1, baseDelayMs: [1], jitterMs: 0 },
    });

    const { result } = await runner.runChatTask({
      taskId: "task_short_repeated",
      sessionKey,
      messageText: "ау",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 350,
    });

    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") throw new Error("expected error");
    expect(result.error.code).toBe("GATEWAY_TIMEOUT");
    expect(JSON.stringify(result)).not.toContain("stale answer");
    await fs.rm(stateDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("aborts active tasks with the OpenClaw chat.abort schema", async () => {
    const request = vi.fn().mockImplementation((method: string) => {
      if (method === "chat.abort") {
        return Promise.resolve({ aborted: true });
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    });
    const runner = new ChatRunner({ request } as never, {
      retry: { attempts: 1, baseDelayMs: [1], jitterMs: 0 },
    });
    (
      runner as unknown as {
        activeRunByTaskId: Map<string, { runId: string; sessionKey: string }>;
      }
    ).activeRunByTaskId.set("task_abort_schema", {
      sessionKey: "tg:449:server",
      runId: "run_abort_schema",
    });

    await expect(runner.abortTask("task_abort_schema", "RELAY_TASK_TIMEOUT")).resolves.toBe(true);

    const abortCall = request.mock.calls.find(([method]) => method === "chat.abort");
    expect(abortCall?.[1]).toEqual({ sessionKey: "tg:449:server", runId: "run_abort_schema" });
  });
});

describe("applyTransportDeliveryInstructions", () => {
  const tgSessionKey = "tg:7278830001:cmo35mexg000693ocdnrknegg";
  const webSessionKey = "webchat:abc";

  it("does not append Telegram note to bare /new on a Telegram session", () => {
    const result = applyTransportDeliveryInstructions({
      sessionKey: tgSessionKey,
      messageText: "/new",
      deliverySystem: "relay_channel_v2",
    });
    expect(result).toBe("/new");
    expect(result).not.toContain("[Telegram plugin note]");
  });

  it("does not append note to other known openclaw slash-commands", () => {
    for (const cmd of ["/compact", "/clear", "  /new  "]) {
      const result = applyTransportDeliveryInstructions({
        sessionKey: tgSessionKey,
        messageText: cmd,
        deliverySystem: "relay_channel_v2",
      });
      expect(result).toBe(cmd.trim());
      expect(result).not.toContain("[Telegram plugin note]");
    }
  });

  it("does not append note to a slash-command with arguments", () => {
    const result = applyTransportDeliveryInstructions({
      sessionKey: tgSessionKey,
      messageText: "/new reset full context",
      deliverySystem: "relay_channel_v2",
    });
    expect(result).toBe("/new reset full context");
    expect(result).not.toContain("[Telegram plugin note]");
  });

  it("leaves ordinary model-bound text untouched", () => {
    const result = applyTransportDeliveryInstructions({
      sessionKey: tgSessionKey,
      messageText: "hello world",
      deliverySystem: "relay_channel_v2",
    });
    expect(result).toBe("hello world");
    expect(result).not.toContain("[Telegram plugin note]");
  });

  it("leaves non-transport sessions untouched (no note ever appended)", () => {
    const result = applyTransportDeliveryInstructions({
      sessionKey: webSessionKey,
      messageText: "/new",
      deliverySystem: "relay_channel_v2",
    });
    expect(result).toBe("/new");
    expect(result).not.toContain("[Telegram plugin note]");
  });
});
