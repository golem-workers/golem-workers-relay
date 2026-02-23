import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayClient } from "./gatewayClient.js";
import { ChatRunner } from "./chatRunner.js";
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

describe("ChatRunner", () => {
  it("maps chat final event with message to reply", async () => {
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
                policy: { tickIntervalMs: 5000 },
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
    runner = new ChatRunner(client);

    await client.start();
    const { result } = await runner.runChatTask({
      taskId: "task_1",
      sessionKey: "s1",
      messageText: "hi",
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe("reply");

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
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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
      transcription: { apiKey: "dg", timeoutMs: 1000 },
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

  it("falls back to original message when transcription fails", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";

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
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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
      transcription: { apiKey: "dg", timeoutMs: 1000 },
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
    expect(result.outcome).toBe("reply");
    expect(sentMessage).toBe("keep me");

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("skips transcription when apiKey is empty", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    let sentMessage = "";
    const transcribeAudio = vi.fn().mockResolvedValue("should not be used");

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
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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
      transcription: { apiKey: "   ", timeoutMs: 1000 },
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
    expect(sentMessage).toBe("keep original");
    expect(transcribeAudio).not.toHaveBeenCalled();

    client.stop();
    await new Promise<void>((r) => wss.close(() => r()));
  });

  it("passes language hint to injected transcriber (OpenAI-style config)", async () => {
    const tmp = `/tmp/gw-relay-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    vi.stubEnv("OPENCLAW_STATE_DIR", tmp);
    const transcribeAudio = vi.fn().mockResolvedValue("voice text");
    let sentMessage = "";

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
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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
      transcription: { apiKey: "openai-key", language: "ru", timeoutMs: 1000 },
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
        apiKey: "openai-key",
        language: "ru",
      }),
    );
    expect(sentMessage).toContain("[Voice transcript]");
    expect(sentMessage).toContain("voice text");

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
        if (frame.type === "req" && frame.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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

  it("attaches transcript MEDIA files as base64", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    // Create a minimal OpenClaw state layout with workspace + sessions map + transcript.
    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(path.join(workspaceRoot, "avatars"), { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "avatars", "klava.svg"), "<svg/>", "utf8");

    const sessionKey = "tg:449:server";
    const sessionId = "sess-1";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const sessionsMap = {
      [`agent:main:${sessionKey}`]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    };
    await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(sessionsMap), "utf8");
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Here you go.\n\nMEDIA: avatars/klava.svg\n\n[[reply_to_current]]",
          },
        ],
      },
    });
    await fs.writeFile(sessionFile, `${line}\n`, "utf8");

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
              payload: { type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 5000 } },
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
                payload: { runId, sessionKey, seq: 1, state: "final", message: { text: "ok" } },
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
    expect(Array.isArray(result.reply.media)).toBe(true);
    expect(result.reply.media?.[0]?.fileName).toBe("klava.svg");
    expect(result.reply.media?.[0]?.contentType).toBe("image/svg+xml");
    expect(result.reply.media?.[0]?.dataB64).toBe(Buffer.from("<svg/>", "utf8").toString("base64"));

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

