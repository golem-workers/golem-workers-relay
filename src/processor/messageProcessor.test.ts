import { describe, expect, it, vi } from "vitest";
import { createMessageProcessor } from "./messageProcessor.js";
import type { InboundPushMessage } from "../backend/types.js";

describe("createMessageProcessor", () => {
  it("forwards relay openclawMeta as-is", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const openclawMeta = {
      method: "chat.send",
      model: "moonshot/kimi-k2.5",
      usage: {
        model: "moonshot/kimi-k2.5",
        inputTokens: 80,
        outputTokens: 30,
        cacheReadTokens: 6,
        totalTokens: 116,
      },
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
          model?: unknown;
          usage?: Record<string, unknown>;
          trace?: Record<string, unknown>;
        }
      | undefined;
    expect(meta?.model).toBe("moonshot/kimi-k2.5");
    expect(meta?.usage?.model).toBe("moonshot/kimi-k2.5");
    expect(meta?.usage?.inputTokens).toBe(80);
    expect(meta?.usage?.outputTokens).toBe(30);
    expect(meta?.usage?.cacheReadTokens).toBe(6);
    expect(meta?.usage?.totalTokens).toBe(116);
    expect(meta?.trace?.backendMessageId).toBe("msg_1");
    expect(meta?.trace?.relayInstanceId).toBe("relay_1");
    expect(meta?.trace?.openclawRunId).toBe("run_1");
    expect(typeof meta?.trace?.relayMessageId).toBe("string");
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
});

