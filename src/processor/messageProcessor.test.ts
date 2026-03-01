import { describe, expect, it, vi } from "vitest";
import { createMessageProcessor } from "./messageProcessor.js";
import type { InboundPushMessage } from "../backend/types.js";

describe("createMessageProcessor", () => {
  it("adds normalized usage into openclawMeta from sessions.usage snapshots", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
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
          openclawMeta: {
            method: "chat.send",
            usageIncoming: {
              source: "sessions.usage",
              totals: { input: 100, output: 20, cacheRead: 3, totalTokens: 123 },
            },
            usageOutgoing: {
              source: "sessions.usage",
              totals: { input: 180, output: 50, cacheRead: 9, totalTokens: 239 },
              aggregates: { byModel: [{ provider: "moonshot", model: "kimi-k2.5" }] },
            },
          },
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
    expect(firstCall?.body?.openclawMeta?.model).toBe("moonshot/kimi-k2.5");
    expect(firstCall?.body?.openclawMeta?.usage?.model).toBe("moonshot/kimi-k2.5");
    expect(firstCall?.body?.openclawMeta?.usage?.inputTokens).toBe(80);
    expect(firstCall?.body?.openclawMeta?.usage?.outputTokens).toBe(30);
    expect(firstCall?.body?.openclawMeta?.usage?.cacheReadTokens).toBe(6);
    expect(firstCall?.body?.openclawMeta?.usage?.totalTokens).toBe(116);
  });

  it("keeps existing usage untouched when relay already provides it", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const existingUsage = {
      model: "moonshot/kimi-k2.5",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 1,
      totalTokens: 14,
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
          openclawMeta: {
            method: "chat.send",
            model: "moonshot/kimi-k2.5",
            usage: existingUsage,
          },
        }),
      } as never,
      backend: { submitInboundMessage } as never,
    });

    await processor({
      messageId: "msg_1",
      input: {
        kind: "chat",
        sessionKey: "s1",
        messageText: "ping",
      },
    });

    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | { body?: { openclawMeta?: { usage?: unknown } } }
      | undefined;
    expect(firstCall?.body?.openclawMeta?.usage).toEqual(existingUsage);
  });
});

