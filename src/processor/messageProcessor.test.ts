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
});

