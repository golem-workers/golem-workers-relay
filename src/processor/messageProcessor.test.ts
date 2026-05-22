import { beforeEach, describe, expect, it, vi } from "vitest";
const { executeTelegramTransportActionViaBackendMock, executeWhatsAppPersonalMessageSendMock } = vi.hoisted(() => ({
  executeTelegramTransportActionViaBackendMock: vi.fn(),
  executeWhatsAppPersonalMessageSendMock: vi.fn(),
}));

vi.mock("../relayChannel/telegramBackendTransport.js", () => ({
  executeTelegramTransportActionViaBackend: executeTelegramTransportActionViaBackendMock,
}));

vi.mock("../relayChannel/whatsappPersonalTransport.js", () => ({
  executeWhatsAppPersonalMessageSend: executeWhatsAppPersonalMessageSendMock,
}));

import { createMessageProcessor, createRelayTaskControl } from "./messageProcessor.js";
import type { InboundPushMessage } from "../backend/types.js";
import { createRelayChannelTransportDeliveryTracker } from "../relayChannel/transportDeliveryTracker.js";

describe("createMessageProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers relay_channel_v2 telegram replies via backend when SDK did not send", async () => {
    executeTelegramTransportActionViaBackendMock.mockResolvedValueOnce({
      transportMessageId: "tg-direct-1",
    });
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const runChatTask = vi.fn().mockResolvedValue({
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
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
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

    expect(runChatTask).toHaveBeenCalledWith(
      expect.objectContaining({
        originRoute: {
          originatingChannel: "relay-channel",
          originatingTo: "telegram:123",
          originatingAccountId: "default",
        },
      })
    );
    expect(executeTelegramTransportActionViaBackendMock).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            openclawMeta?: {
              transportChannelId?: string;
              transportAccountId?: string;
              transportMessageId?: string;
              transportDelivered?: boolean;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.openclawMeta?.transportChannelId).toBe("telegram");
    expect(firstCall?.body?.openclawMeta?.transportAccountId).toBe("default");
    expect(firstCall?.body?.openclawMeta?.transportMessageId).toBe("tg-direct-1");
    expect(firstCall?.body?.openclawMeta?.transportDelivered).toBe(true);
  });

  it("passes group telegram origin route to chat runner", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const runChatTask = vi.fn().mockResolvedValue({
      result: {
        outcome: "no_reply",
        noReply: { runId: "run_group_1" },
      },
      openclawMeta: { method: "chat.send", runId: "run_group_1" },
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
      messageId: "msg_group_1",
      input: {
        kind: "chat",
        sessionKey: "tg:-5292069601:srv_1",
        messageText: "ping",
        context: {
          channel: "telegram",
          telegram: {
            chatId: "-5292069601",
            messageId: "55",
            chatType: "group",
          },
        },
      },
    });

    expect(runChatTask).toHaveBeenCalledWith(
      expect.objectContaining({
        originRoute: {
          originatingChannel: "relay-channel",
          originatingTo: "telegram:group:-5292069601",
          originatingAccountId: "default",
        },
      })
    );
  });

  it("marks relay_channel_v2 telegram replies as SDK-delivered when relay-channel already sent", async () => {
    const transportDeliveryTracker = createRelayChannelTransportDeliveryTracker();
    transportDeliveryTracker.recordSdkDelivery({
      correlationMessageId: "msg_v2_sdk_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-sdk-1",
    });
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
              runId: "run_v2_sdk_1",
              message: { role: "assistant", content: "Ответил в чат." },
            },
          },
          openclawMeta: { method: "chat.send", runId: "run_v2_sdk_1" },
        }),
      } as never,
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
      transportDeliveryTracker,
    });

    await processor({
      messageId: "msg_v2_sdk_1",
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

    expect(executeTelegramTransportActionViaBackendMock).not.toHaveBeenCalled();
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            openclawMeta?: {
              transportChannelId?: string;
              transportAccountId?: string;
              transportMessageId?: string;
              transportDelivered?: boolean;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.openclawMeta?.transportChannelId).toBe("telegram");
    expect(firstCall?.body?.openclawMeta?.transportAccountId).toBe("default");
    expect(firstCall?.body?.openclawMeta?.transportMessageId).toBe("tg-sdk-1");
    expect(firstCall?.body?.openclawMeta?.transportDelivered).toBe(true);
  });

  it("delivers relay_channel_v2 WhatsApp Personal replies via backend when SDK did not send", async () => {
    executeWhatsAppPersonalMessageSendMock.mockResolvedValueOnce({
      transportMessageId: "wa-direct-1",
    });
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
              runId: "run_wa_v2_1",
              message: { role: "assistant", content: "hello from wa plugin\n\n[[media:files/report.pdf]]" },
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
          openclawMeta: { method: "chat.send", runId: "run_wa_v2_1" },
        }),
      } as never,
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
    });

    await processor({
      messageId: "msg_wa_v2_1",
      input: {
        kind: "chat",
        sessionKey: "whatsapp-personal:12345@s.whatsapp.net",
        messageText: "ping",
        context: {
          channel: "whatsapp_personal",
          deliverySystem: "relay_channel_v2",
          whatsappPersonal: {
            chatId: "12345@s.whatsapp.net",
            messageId: "wamid-1",
          },
        },
      },
    });

    expect(executeWhatsAppPersonalMessageSendMock).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            openclawMeta?: {
              transportChannelId?: string;
              transportAccountId?: string;
              transportMessageId?: string;
              transportDelivered?: boolean;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.openclawMeta?.transportChannelId).toBe("whatsapp_personal");
    expect(firstCall?.body?.openclawMeta?.transportAccountId).toBe("default");
    expect(firstCall?.body?.openclawMeta?.transportMessageId).toBe("wa-direct-1");
    expect(firstCall?.body?.openclawMeta?.transportDelivered).toBe(true);
  });

  it("preserves direct transport delivery failures for relay_channel_v2 replies", async () => {
    executeTelegramTransportActionViaBackendMock.mockRejectedValueOnce(
      new Error("Telegram API error 400: Bad Request: replied message not found")
    );
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
              runId: "run_v2_fail_1",
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
          openclawMeta: { method: "chat.send", runId: "run_v2_fail_1" },
        }),
      } as never,
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
    });

    await processor({
      messageId: "msg_v2_fail_1",
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

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
            error?: {
              code?: string;
              message?: string;
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("error");
    expect(firstCall?.body?.error).toEqual({
      code: "RELAY_DIRECT_TRANSPORT_DELIVERY_FAILED",
      message:
        "Relay direct telegram delivery failed: Telegram API error 400: Bad Request: replied message not found",
    });
  });

  it("does not surface direct transport executor failures for SDK-delivered replies", async () => {
    const transportDeliveryTracker = createRelayChannelTransportDeliveryTracker();
    transportDeliveryTracker.recordSdkDelivery({
      correlationMessageId: "msg_v2_fail_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-sdk-1",
    });
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
              runId: "run_v2_fail_1",
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
          openclawMeta: { method: "chat.send", runId: "run_v2_fail_1" },
        }),
      } as never,
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
      transportDeliveryTracker,
    });

    await processor({
      messageId: "msg_v2_fail_1",
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

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
            openclawMeta?: {
              transportDelivered?: boolean;
              transportChannelId?: string;
              transportMessageId?: string;
            };
          };
        }
      | undefined;
    expect(executeTelegramTransportActionViaBackendMock).not.toHaveBeenCalled();
    expect(firstCall?.body?.outcome).toBe("reply");
    expect(firstCall?.body?.openclawMeta?.transportDelivered).toBe(true);
    expect(firstCall?.body?.openclawMeta?.transportChannelId).toBe("telegram");
    expect(firstCall?.body?.openclawMeta?.transportMessageId).toBe("tg-sdk-1");
  });

  it("accepts user-facing replies when transport can be resolved from session key", async () => {
    executeTelegramTransportActionViaBackendMock.mockResolvedValueOnce({
      transportMessageId: "tg-session-1",
    });
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
              runId: "run_no_context_1",
              message: { role: "assistant", content: "hello user" },
            },
          },
          openclawMeta: { method: "chat.send", runId: "run_no_context_1" },
        }),
      } as never,
      backend: { submitInboundMessage, sendTelegramTransportAction: vi.fn() } as never,
    });

    await processor({
      messageId: "msg_no_context_1",
      input: {
        kind: "chat",
        sessionKey: "tg:123:srv_1",
        messageText: "ping",
      },
    });

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    expect(executeTelegramTransportActionViaBackendMock).toHaveBeenCalledTimes(1);
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "reply",
        openclawMeta: {
          deliverySystem: "relay_channel_v2",
          sessionKey: "tg:123:srv_1",
          transportDelivered: true,
          transportChannelId: "telegram",
          transportMessageId: "tg-session-1",
        },
      },
    });
  });

  it("times out stuck chat tasks, aborts them, and ignores late completion", async () => {
    let resolveRun!: (value: {
      result: {
        outcome: "reply";
        reply: { runId: string; message: { role: string; content: string } };
      };
      openclawMeta: { method: string; runId: string };
    }) => void;
    const runChatTask = vi.fn(
      () =>
        new Promise<{
          result: {
            outcome: "reply";
            reply: { runId: string; message: { role: string; content: string } };
          };
          openclawMeta: { method: string; runId: string };
        }>((resolve) => {
          resolveRun = resolve;
        })
    );
    const abortTask = vi.fn().mockResolvedValue(true);
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 5,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask, abortTask } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_timeout_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "hang",
      },
    });

    expect(abortTask).toHaveBeenCalledWith("msg_timeout_1", "RELAY_TASK_TIMEOUT");
    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "error",
        error: { code: "RELAY_TASK_TIMEOUT" },
        openclawMeta: {
          trace: { backendMessageId: "msg_timeout_1", relayInstanceId: "relay_1" },
          sessionKey: "s1",
        },
      },
    });

    resolveRun({
      result: { outcome: "reply", reply: { runId: "late_run_1", message: { role: "assistant", content: "late" } } },
      openclawMeta: { method: "chat.send", runId: "late_run_1" },
    });
    await Promise.resolve();
    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("refreshes the chat task timeout when OpenClaw reports activity", async () => {
    vi.useFakeTimers();
    try {
      const runChatTask = vi.fn(
        (input: {
          onActivity?: (activity: { runId: string; state: string; observedAtMs: number }) => void;
        }) =>
          new Promise<{
            result: {
              outcome: "reply";
              reply: { runId: string; message: { role: string; content: string } };
            };
            openclawMeta: { method: string; runId: string };
          }>((resolve) => {
            setTimeout(() => input.onActivity?.({ runId: "run_active_1", state: "delta", observedAtMs: Date.now() }), 3);
            setTimeout(() => input.onActivity?.({ runId: "run_active_1", state: "delta", observedAtMs: Date.now() }), 7);
            setTimeout(
              () =>
                resolve({
                  result: {
                    outcome: "reply",
                    reply: { runId: "run_active_1", message: { role: "assistant", content: "done" } },
                  },
                  openclawMeta: { method: "chat.send", runId: "run_active_1" },
                }),
              9
            );
          })
      );
      const abortTask = vi.fn().mockResolvedValue(true);
      const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
      const processor = createMessageProcessor({
        cfg: {
          relayInstanceId: "relay_1",
          taskTimeoutMs: 5,
          chatBatchDebounceMs: 0,
          devLogEnabled: false,
          devLogTextMaxLen: 200,
        },
        gateway: { start: vi.fn(), getHello: vi.fn() } as never,
        runner: { runChatTask, abortTask } as never,
        backend: { submitInboundMessage } as never,
      });

      const processing = processor({
        messageId: "msg_active_1",
        input: {
          kind: "chat",
          sessionKey: "s1",
          messageText: "work",
        },
      });

      await vi.advanceTimersByTimeAsync(9);
      await processing;

      expect(abortTask).not.toHaveBeenCalled();
      expect(submitInboundMessage).toHaveBeenCalledTimes(1);
      expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
        body: {
          outcome: "reply",
          reply: { message: { content: "done" } },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the shorter system task timeout for stale reminders", async () => {
    const taskControl = createRelayTaskControl();
    const runChatTask = vi.fn(() => new Promise(() => undefined));
    const abortTask = vi.fn().mockResolvedValue(true);
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 1_000,
        systemTaskTimeoutMs: 5,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask, abortTask } as never,
      backend: { submitInboundMessage } as never,
      taskControl,
    });

    await processor({
      messageId: "relay-stale:source_1:test",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "status?",
        context: { kind: "relay_stale_timeout_reminder", sourceBackendMessageId: "source_1" },
      },
    });

    expect(runChatTask).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5 }));
    expect(abortTask).toHaveBeenCalledWith("relay-stale:source_1:test", "RELAY_SYSTEM_TASK_TIMEOUT");
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "error",
        error: { code: "RELAY_SYSTEM_TASK_TIMEOUT" },
      },
    });
    expect(taskControl.getActiveTasks()).toEqual([]);
  });

  it("preempts active user chat when task control aborts them", async () => {
    const taskControl = createRelayTaskControl();
    const runChatTask = vi.fn(() => new Promise(() => undefined));
    const abortTask = vi.fn().mockResolvedValue(true);
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 1_000,
        systemTaskTimeoutMs: 1_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask, abortTask } as never,
      backend: { submitInboundMessage } as never,
      taskControl,
    });

    const processing = processor({
      messageId: "user_msg_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "hello",
      },
    });
    await Promise.resolve();

    const aborted = taskControl.abortActive(
      (task) => task.taskKind === "user_chat" && task.sessionKey === "s1",
      "newer_user_message"
    );
    expect(aborted).toBe(true);
    await processing;

    expect(abortTask).toHaveBeenCalledWith("user_msg_1", "RELAY_TASK_PREEMPTED");
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "error",
        error: { code: "RELAY_TASK_PREEMPTED" },
      },
    });
    expect(taskControl.getActiveTasks()).toEqual([]);
  });

  it("preempts active system reminders when task control aborts them", async () => {
    const taskControl = createRelayTaskControl();
    const runChatTask = vi.fn(() => new Promise(() => undefined));
    const abortTask = vi.fn().mockResolvedValue(true);
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 1_000,
        systemTaskTimeoutMs: 1_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask, abortTask } as never,
      backend: { submitInboundMessage } as never,
      taskControl,
    });

    const processing = processor({
      messageId: "relay-stale:source_1:test",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "status?",
        context: { kind: "relay_stale_timeout_reminder", sourceBackendMessageId: "source_1" },
      },
    });
    await Promise.resolve();

    const aborted = taskControl.abortActive(
      (task) => task.taskKind === "system_reminder" && task.sessionKey === "s1",
      "newer_user_message"
    );
    expect(aborted).toBe(true);
    await processing;

    expect(abortTask).toHaveBeenCalledWith("relay-stale:source_1:test", "RELAY_TASK_PREEMPTED");
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "error",
        error: { code: "RELAY_TASK_PREEMPTED" },
      },
    });
    expect(taskControl.getActiveTasks()).toEqual([]);
  });

  it("tracks and aborts multiple active relay tasks", async () => {
    const taskControl = createRelayTaskControl();
    const runChatTask = vi.fn(() => new Promise(() => undefined));
    const abortTask = vi.fn().mockResolvedValue(true);
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const processor = createMessageProcessor({
      cfg: {
        relayInstanceId: "relay_1",
        taskTimeoutMs: 1_000,
        systemTaskTimeoutMs: 1_000,
        chatBatchDebounceMs: 0,
        devLogEnabled: false,
        devLogTextMaxLen: 200,
      },
      gateway: { start: vi.fn(), getHello: vi.fn() } as never,
      runner: { runChatTask, abortTask } as never,
      backend: { submitInboundMessage } as never,
      taskControl,
    });

    const first = processor({
      messageId: "relay-stale:source_1:test",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "status?",
        context: { kind: "relay_stale_timeout_reminder", sourceBackendMessageId: "source_1" },
      },
    });
    const second = processor({
      messageId: "relay-stale:source_2:test",
      input: {
        kind: "chat",
        sessionKey: "s2",
        messageText: "status?",
        context: { kind: "relay_stale_timeout_reminder", sourceBackendMessageId: "source_2" },
      },
    });
    await Promise.resolve();

    expect(taskControl.getActiveTasks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: "relay-stale:source_1:test", sessionKey: "s1" }),
        expect.objectContaining({ messageId: "relay-stale:source_2:test", sessionKey: "s2" }),
      ])
    );

    const aborted = taskControl.abortActive((task) => task.taskKind === "system_reminder", "newer_user_message");
    expect(aborted).toBe(true);
    await Promise.all([first, second]);

    expect(abortTask).toHaveBeenCalledWith("relay-stale:source_1:test", "RELAY_TASK_PREEMPTED");
    expect(abortTask).toHaveBeenCalledWith("relay-stale:source_2:test", "RELAY_TASK_PREEMPTED");
    expect(taskControl.getActiveTasks()).toEqual([]);
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
    expect(meta?.deliverySystem).toBe("relay_channel_v2");
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

  it("submits unresolved artifact replies without legacy retry notices", async () => {
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

    expect(runChatTask).toHaveBeenCalledTimes(1);
    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const submitted = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { reply?: { message?: { content?: string }; artifactResolution?: unknown } } }
      | undefined;
    expect(submitted?.body?.reply?.message?.content).toBe("Here is your file");
    expect(submitted?.body?.reply?.artifactResolution).toBeDefined();
  });

  it("does not synthesize legacy technical notices after unresolved artifact replies", async () => {
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

    expect(runChatTask).toHaveBeenCalledTimes(1);
    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const submitted = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { reply?: { message?: { content?: string }; artifactResolution?: unknown } } }
      | undefined;
    expect(submitted?.body?.reply?.message?.content).toBe("Original agent text");
    expect(submitted?.body?.reply?.artifactResolution).toBeDefined();
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
