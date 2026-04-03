import { beforeEach, describe, expect, it, vi } from "vitest";
const { executeTelegramMessageSendMock } = vi.hoisted(() => ({
  executeTelegramMessageSendMock: vi.fn(),
}));

vi.mock("../relayChannel/telegramTransport.js", () => ({
  executeTelegramMessageSend: executeTelegramMessageSendMock,
}));

import { createMessageProcessor } from "./messageProcessor.js";
import type { InboundPushMessage } from "../backend/types.js";

describe("createMessageProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers relay_channel_v2 telegram replies directly through the transport executor", async () => {
    executeTelegramMessageSendMock.mockResolvedValueOnce({ transportMessageId: "tg-msg-1" });
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const getTelegramTransportConfig = vi.fn().mockResolvedValue({
      accessKey: "bot-token",
      apiBaseUrl: "https://api.telegram.org",
      fileBaseUrl: "https://api.telegram.org/file",
    });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: {
              runId: "run_v2_1",
              message: { role: "assistant", content: "hello user\n\n[[media:files/report.pdf]]" },
              media: [
                {
                  path: "files/report.pdf",
                  fileName: "report.pdf",
                  contentType: "application/pdf",
                  sizeBytes: 123,
                },
              ],
            },
          },
          openclawMeta: { method: "chat.send", runId: "run_v2_1" },
        }),
      } as never,
      backend: { submitInboundMessage, getTelegramTransportConfig } as never,
    });

    await processor({
      messageId: "msg_v2_1",
      input: {
        kind: "chat",
        sessionKey: "tg:123:srv_1",
        messageText: "ping",
        context: {
          channel: "telegram",
          deliverySystem: "relay_channel_v2",
          telegram: {
            chatId: "123",
            messageId: "55",
          },
        },
      },
    });

    expect(getTelegramTransportConfig).toHaveBeenCalledTimes(1);
    expect(executeTelegramMessageSendMock).toHaveBeenCalledTimes(1);
    expect(executeTelegramMessageSendMock).toHaveBeenCalledWith({
      accessKey: "bot-token",
      apiBaseUrl: "https://api.telegram.org",
      action: {
        transportTarget: { channel: "telegram", chatId: "123" },
        reply: { replyToTransportMessageId: "55" },
        payload: {
          text: "hello user",
          mediaUrl: "files/report.pdf",
          fileName: "report.pdf",
          contentType: "application/pdf",
        },
      },
    });
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            openclawMeta?: {
              transportChannelId?: string;
              transportAccountId?: string;
              transportMessageId?: string;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.openclawMeta?.transportChannelId).toBe("telegram");
    expect(firstCall?.body?.openclawMeta?.transportAccountId).toBe("default");
    expect(firstCall?.body?.openclawMeta?.transportMessageId).toBe("tg-msg-1");
  });

  it("emits a technical callback before processing when disk usage is above threshold", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        lowDiskAlertEnabled: true,
        lowDiskAlertThresholdPercent: 80,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: { runId: "run_disk_1", message: { role: "assistant", content: "ok" } },
          },
          openclawMeta: { method: "chat.send", runId: "run_disk_1" },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
      readDiskUsage: vi.fn().mockResolvedValue({
        totalBytes: 100,
        availableBytes: 15,
        usedBytes: 85,
        usedPercent: 85,
      }),
    });

    await processor({
      messageId: "msg_disk_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "ping",
      },
    });

    expect(submitInboundMessage).toHaveBeenCalledTimes(2);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
            technical?: {
              source?: string;
              event?: string;
              thresholdPercent?: number;
              usedPercent?: number;
              availableBytes?: number;
              totalBytes?: number;
            };
          };
        }
      | undefined;
    const secondCall = submitInboundMessage.mock.calls[1]?.[0] as
      | {
          body?: {
            outcome?: string;
          };
        }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("technical");
    expect(firstCall?.body?.technical).toMatchObject({
      source: "relay",
      event: "disk.space_low",
      thresholdPercent: 80,
      usedPercent: 85,
      availableBytes: 15,
      totalBytes: 100,
    });
    expect(secondCall?.body?.outcome).toBe("reply");
  });

  it("does not emit a technical callback when disk usage is below threshold", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        lowDiskAlertEnabled: true,
        lowDiskAlertThresholdPercent: 80,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: { runId: "run_ok_1", message: { role: "assistant", content: "ok" } },
          },
          openclawMeta: { method: "chat.send", runId: "run_ok_1" },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
      readDiskUsage: vi.fn().mockResolvedValue({
        totalBytes: 100,
        availableBytes: 40,
        usedBytes: 60,
        usedPercent: 60,
      }),
    });

    await processor({
      messageId: "msg_ok_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "ping",
      },
    });

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
          };
        }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("reply");
  });

  it("forwards only allowed openclawMeta fields", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const openclawMeta = {
      method: "chat.send",
      runId: "run_1",
      model: "moonshot/kimi-k2.5",
      trace: {
        backendMessageId: "legacy-backend-id",
        relayMessageId: "legacy-relay-id",
        relayInstanceId: "legacy-relay",
        openclawRunId: "legacy-openclaw-run-id",
        extra: "remove-me",
      },
      legacy: "remove-me",
    };
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: { runId: "run_1", message: { text: "hello" } },
          },
          openclawMeta,
        }),
      } as never,
      backend: { submitInboundMessage } as never,
    });

    const message: InboundPushMessage = {
      messageId: "msg_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "ping",
      },
    };

    await processor(message);

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { outcome?: unknown; openclawMeta?: { model?: unknown; usage?: Record<string, unknown> } } }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("reply");
    const meta = firstCall?.body?.openclawMeta as
      | {
          method?: unknown;
          runId?: unknown;
          model?: unknown;
          trace?: Record<string, unknown>;
          legacy?: unknown;
        }
      | undefined;
    expect(meta?.method).toBe("chat.send");
    expect(meta?.runId).toBe("run_1");
    expect(meta?.model).toBe("moonshot/kimi-k2.5");
    expect(meta?.legacy).toBeUndefined();
    expect(meta?.trace?.backendMessageId).toBe("msg_1");
    expect(meta?.trace?.relayInstanceId).toBe("relay_1");
    expect(meta?.trace?.openclawRunId).toBe("run_1");
    expect(meta?.trace?.extra).toBeUndefined();
    expect(typeof meta?.trace?.relayMessageId).toBe("string");
    expect(meta?.deliverySystem).toBe("legacy_push_v1");
  });

  it("preserves extra reply fields from ChatRunner", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: {
              runId: "run_tech_1",
              message: { role: "assistant", content: "ok" },
              openclawEvents: [
                { runId: "run_tech_1", sessionKey: "s1", seq: 0, state: "delta", message: { text: "ping" } },
                { runId: "run_tech_1", sessionKey: "s1", seq: 1, state: "final", message: { text: "ok" } },
              ],
            },
          },
          openclawMeta: { method: "chat.send", runId: "run_tech_1" },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
    });

    const message: InboundPushMessage = {
      messageId: "msg_tech_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "ping",
      },
    };

    await processor(message);

    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { reply?: { openclawEvents?: unknown[]; runId?: string } } }
      | undefined;
    expect(firstCall?.body?.reply?.runId).toBe("run_tech_1");
    expect(Array.isArray(firstCall?.body?.reply?.openclawEvents)).toBe(true);
    expect(firstCall?.body?.reply?.openclawEvents).toHaveLength(2);
  });

  it("forwards structured reply artifacts and keeps legacy media compatibility", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "reply",
            reply: {
              runId: "run_artifact_1",
              message: { role: "assistant", content: "done" },
              artifacts: [
                {
                  path: "videos/final_ytp.mp4",
                  fileName: "final_ytp.mp4",
                  kind: "video",
                  contentType: "video/mp4",
                  sizeBytes: 2_749_256,
                },
              ],
            },
          },
          openclawMeta: { method: "chat.send", runId: "run_artifact_1" },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_artifact_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "send the file",
      },
    });

    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            reply?: {
              artifacts?: Array<{ path?: string; fileName?: string; kind?: string; contentType?: string }>;
              media?: Array<{ path?: string; fileName?: string; contentType?: string }>;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.reply?.artifacts).toEqual([
      {
        path: "videos/final_ytp.mp4",
        fileName: "final_ytp.mp4",
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 2_749_256,
      },
    ]);
    expect(firstCall?.body?.reply?.media).toEqual([
      {
        path: "videos/final_ytp.mp4",
        fileName: "final_ytp.mp4",
        contentType: "video/mp4",
        sizeBytes: 2_749_256,
      },
    ]);
  });

  it("sends retry notice and then retry result when the first reply has unresolved artifacts", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const runChatTask = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          outcome: "reply",
          reply: {
            runId: "run_first",
            message: { role: "assistant", content: "Here is your file" },
            artifactResolution: {
              requestedCount: 1,
              recoveredCount: 0,
              usedStructuredArtifacts: false,
              usedLegacyMediaDirectives: true,
              artifacts: [],
              unresolved: [
                {
                  source: "media_directive",
                  reason: "missing_file",
                  path: "cyber_yytp/final_ytp.mp4",
                  fileName: "final_ytp.mp4",
                },
              ],
            },
          },
        },
        openclawMeta: { method: "chat.send", runId: "run_first" },
      })
      .mockResolvedValueOnce({
        result: {
          outcome: "reply",
          reply: {
            runId: "run_retry",
            message: { role: "assistant", content: "Here is your file" },
            artifacts: [
              {
                path: "files/final_ytp.mp4",
                fileName: "final_ytp.mp4",
                kind: "video",
                contentType: "video/mp4",
                sizeBytes: 100,
              },
            ],
            artifactResolution: {
              requestedCount: 1,
              recoveredCount: 1,
              usedStructuredArtifacts: false,
              usedLegacyMediaDirectives: true,
              artifacts: [
                {
                  path: "files/final_ytp.mp4",
                  fileName: "final_ytp.mp4",
                  kind: "video",
                  contentType: "video/mp4",
                  sizeBytes: 100,
                },
              ],
              unresolved: [],
            },
          },
        },
        openclawMeta: { method: "chat.send", runId: "run_retry" },
      });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_retry_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "send file",
      },
    });

    expect(runChatTask).toHaveBeenCalledTimes(2);
    expect(runChatTask.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        taskId: "msg_retry_1:artifact-retry",
        sessionKey: "s1",
      })
    );
    expect(submitInboundMessage).toHaveBeenCalledTimes(2);
    const notice = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { reply?: { message?: { content?: string } }; openclawMeta?: { artifactDelivery?: { stage?: string; originalRunId?: string } } } }
      | undefined;
    const retried = submitInboundMessage.mock.calls[1]?.[0] as
      | {
          body?: {
            reply?: { artifacts?: Array<{ path?: string }> };
            openclawMeta?: { artifactDelivery?: { stage?: string; originalRunId?: string; retryRunId?: string } };
          };
        }
      | undefined;
    expect(notice?.body?.reply?.message?.content).toBe(
      "We hit a temporary issue while preparing the file attachment. We are trying one more time now."
    );
    expect(notice?.body?.openclawMeta?.artifactDelivery).toMatchObject({
      stage: "retry_notice",
      originalRunId: "run_first",
    });
    expect(retried?.body?.reply?.artifacts?.[0]?.path).toBe("files/final_ytp.mp4");
    expect(retried?.body?.openclawMeta?.artifactDelivery).toMatchObject({
      stage: "retry_succeeded",
      originalRunId: "run_first",
      retryRunId: "run_retry",
    });
  });

  it("falls back to original text and a technical notice after one failed artifact retry", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const unresolvedArtifact = {
      source: "media_directive",
      reason: "missing_file",
      path: "cyber_yytp/final_ytp.mp4",
      fileName: "final_ytp.mp4",
    };
    const runChatTask = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          outcome: "reply",
          reply: {
            runId: "run_first_fail",
            message: { role: "assistant", content: "Original agent text" },
            artifactResolution: {
              requestedCount: 1,
              recoveredCount: 0,
              usedStructuredArtifacts: false,
              usedLegacyMediaDirectives: true,
              artifacts: [],
              unresolved: [unresolvedArtifact],
            },
          },
        },
        openclawMeta: { method: "chat.send", runId: "run_first_fail" },
      })
      .mockResolvedValueOnce({
        result: {
          outcome: "reply",
          reply: {
            runId: "run_retry_fail",
            message: { role: "assistant", content: "Retry text" },
            artifactResolution: {
              requestedCount: 1,
              recoveredCount: 0,
              usedStructuredArtifacts: false,
              usedLegacyMediaDirectives: true,
              artifacts: [],
              unresolved: [unresolvedArtifact],
            },
          },
        },
        openclawMeta: { method: "chat.send", runId: "run_retry_fail" },
      });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_retry_fail_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "send file",
      },
    });

    expect(submitInboundMessage).toHaveBeenCalledTimes(3);
    const originalReply = submitInboundMessage.mock.calls[1]?.[0] as
      | {
          body?: {
            reply?: { message?: { content?: string } };
            openclawMeta?: {
              artifactDelivery?: { stage?: string; originalRunId?: string; retryRunId?: string; retryOutcome?: string };
            };
          };
        }
      | undefined;
    const technicalNotice = submitInboundMessage.mock.calls[2]?.[0] as
      | {
          body?: {
            reply?: { message?: { content?: string } };
            openclawMeta?: {
              artifactDelivery?: { stage?: string; originalRunId?: string; retryRunId?: string; retryOutcome?: string };
            };
          };
        }
      | undefined;
    expect(originalReply?.body?.reply?.message?.content).toBe("Original agent text");
    expect(originalReply?.body?.openclawMeta?.artifactDelivery).toMatchObject({
      stage: "fallback_text",
      originalRunId: "run_first_fail",
      retryRunId: "run_retry_fail",
      retryOutcome: "reply",
    });
    expect(technicalNotice?.body?.reply?.message?.content).toBe(
      "Technical note: the agent message was delivered, but the file attachment could not be sent."
    );
    expect(technicalNotice?.body?.openclawMeta?.artifactDelivery).toMatchObject({
      stage: "failure_notice",
      originalRunId: "run_first_fail",
      retryRunId: "run_retry_fail",
      retryOutcome: "reply",
    });
  });

  it("debounces chat messages per session and sends batch", async () => {
    vi.useFakeTimers();
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const runChatTask = vi.fn().mockResolvedValue({
      result: {
        outcome: "reply",
        reply: { runId: "run_batch_1", message: { role: "assistant", content: "ok" } },
      },
      openclawMeta: { method: "chat.send", runId: "run_batch_1" },
    });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 5_000,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask } as never,
      backend: { submitInboundMessage } as never,
    });

    const first = processor({
      messageId: "msg_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "first",
      },
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(runChatTask).toHaveBeenCalledTimes(0);

    const second = processor({
      messageId: "msg_2",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "second",
      },
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(runChatTask).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);

    expect(runChatTask).toHaveBeenCalledTimes(1);
    expect(runChatTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "msg_2",
        sessionKey: "s1",
        messageText: "first\n\nsecond",
      })
    );
    expect(submitInboundMessage).toHaveBeenCalledTimes(2);
    const noReply = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { outcome?: string; noReply?: { reason?: string; batchedIntoMessageId?: string } } }
      | undefined;
    expect(noReply?.body?.outcome).toBe("no_reply");
    expect(noReply?.body?.noReply?.reason).toBe("batched");
    expect(noReply?.body?.noReply?.batchedIntoMessageId).toBe("msg_2");

    const reply = submitInboundMessage.mock.calls[1]?.[0] as
      | { body?: { outcome?: string; openclawMeta?: { trace?: { backendMessageId?: string } } } }
      | undefined;
    expect(reply?.body?.outcome).toBe("reply");
    expect(reply?.body?.openclawMeta?.trace?.backendMessageId).toBe("msg_2");
    vi.useRealTimers();
  });

  it("propagates explicit voice transcription errors to backend", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: {
        runChatTask: vi.fn().mockResolvedValue({
          result: {
            outcome: "error",
            error: {
              code: "VOICE_TRANSCRIPTION_FAILED",
              message: "Voice message could not be transcribed, so it was not sent to the model. upstream timeout",
            },
          },
          openclawMeta: { method: "chat.send" },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_voice_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "[Voice message]",
      },
    });

    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { outcome?: string; error?: { code?: string; message?: string } } }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("error");
    expect(firstCall?.body?.error).toEqual({
      code: "VOICE_TRANSCRIPTION_FAILED",
      message: "Voice message could not be transcribed, so it was not sent to the model. upstream timeout",
    });
  });
});

