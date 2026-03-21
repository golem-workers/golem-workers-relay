import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayEventForwarder } from "./gatewayEventForwarder.js";

describe("createGatewayEventForwarder", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("forwards raw gateway events when final-only mode is disabled", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const forward = createGatewayEventForwarder({
      relayInstanceId: "relay_1",
      backend: { submitInboundMessage } as never,
      forwardFinalOnly: false,
      getChatRunTrace: () => null,
    });

    await forward({
      type: "event",
      event: "tick",
      payload: { ts: 123 },
      seq: 7,
      stateVersion: { version: 1 },
    });

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
            technical?: {
              event?: string;
              payload?: unknown;
              seq?: number | null;
              stateVersion?: unknown;
            };
            openclawMeta?: {
              method?: string;
              trace?: {
                relayInstanceId?: string;
              };
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("technical");
    expect(firstCall?.body?.technical?.event).toBe("tick");
    expect(firstCall?.body?.technical?.payload).toEqual({ ts: 123 });
    expect(firstCall?.body?.technical?.seq).toBe(7);
    expect(firstCall?.body?.technical?.stateVersion).toEqual({ version: 1 });
    expect(firstCall?.body?.openclawMeta?.method).toBe("gateway.event.tick");
    expect(firstCall?.body?.openclawMeta?.trace?.relayInstanceId).toBe("relay_1");
  });

  it("buffers delta signals and sends them to backend sorted by seq", async () => {
    vi.useFakeTimers();
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const forward = createGatewayEventForwarder({
      relayInstanceId: "relay_1",
      backend: { submitInboundMessage } as never,
      forwardFinalOnly: true,
      getChatRunTrace: (runId) =>
        runId === "run_1"
          ? {
              backendMessageId: "msg_1",
            }
          : null,
    });

    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 3,
        state: "delta",
        message: { text: "llo" },
      },
    });
    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 2,
        state: "delta",
        message: { text: "hel" },
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(submitInboundMessage).toHaveBeenCalledTimes(4);
    const firstCall = submitInboundMessage.mock.calls[0]?.[0] as
      | {
          body?: {
            outcome?: string;
            technical?: {
              event?: string;
              payload?: unknown;
            };
            openclawMeta?: {
              method?: string;
              runId?: string;
              trace?: {
                backendMessageId?: string;
                relayInstanceId?: string;
                openclawRunId?: string;
              };
            };
          };
        }
      | undefined;
    expect(firstCall?.body?.outcome).toBe("technical");
    expect(firstCall?.body?.technical?.event).toBe("chat.delta_signal");
    expect(firstCall?.body?.technical?.payload).toEqual({
      runId: "run_1",
      sessionKey: "session_1",
      seq: 2,
      state: "delta",
    });
    expect(firstCall?.body?.openclawMeta?.method).toBe("gateway.event.chat.delta_signal");
    expect(firstCall?.body?.openclawMeta?.runId).toBe("run_1");
    expect(firstCall?.body?.openclawMeta?.trace?.backendMessageId).toBe("msg_1");
    expect(firstCall?.body?.openclawMeta?.trace?.relayInstanceId).toBe("relay_1");
    expect(firstCall?.body?.openclawMeta?.trace?.openclawRunId).toBe("run_1");
    const secondCall = submitInboundMessage.mock.calls[1]?.[0] as
      | {
          body?: {
            outcome?: string;
            replyChunk?: {
              text?: string;
              runId?: string;
              seq?: number;
            };
          };
        }
      | undefined;
    expect(secondCall?.body?.outcome).toBe("reply_chunk");
    expect(secondCall?.body?.replyChunk).toEqual({
      text: "hel",
      runId: "run_1",
      seq: 2,
    });
    const thirdCall = submitInboundMessage.mock.calls[2]?.[0] as
      | {
          body?: {
            technical?: {
              payload?: unknown;
            };
          };
        }
      | undefined;
    expect(thirdCall?.body?.technical?.payload).toEqual({
      runId: "run_1",
      sessionKey: "session_1",
      seq: 3,
      state: "delta",
    });
    const fourthCall = submitInboundMessage.mock.calls[3]?.[0] as
      | {
          body?: {
            outcome?: string;
            replyChunk?: {
              text?: string;
              runId?: string;
              seq?: number;
            };
          };
        }
      | undefined;
    expect(fourthCall?.body?.outcome).toBe("reply_chunk");
    expect(fourthCall?.body?.replyChunk).toEqual({
      text: "llo",
      runId: "run_1",
      seq: 3,
    });
  });

  it("drops buffered deltas when a terminal chat event arrives during debounce", async () => {
    vi.useFakeTimers();
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const forward = createGatewayEventForwarder({
      relayInstanceId: "relay_1",
      backend: { submitInboundMessage } as never,
      forwardFinalOnly: true,
      getChatRunTrace: (runId) =>
        runId === "run_1"
          ? {
              backendMessageId: "msg_1",
            }
          : null,
    });

    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 2,
        state: "delta",
        message: { text: "hel" },
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 3,
        state: "final",
        message: { text: "hello" },
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(submitInboundMessage).not.toHaveBeenCalled();
  });

  it("ignores any later delta signals after terminal state was seen", async () => {
    vi.useFakeTimers();
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const forward = createGatewayEventForwarder({
      relayInstanceId: "relay_1",
      backend: { submitInboundMessage } as never,
      forwardFinalOnly: true,
      getChatRunTrace: (runId) =>
        runId === "run_1"
          ? {
              backendMessageId: "msg_1",
            }
          : null,
    });

    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 2,
        state: "delta",
        message: { text: "hel" },
      },
    });
    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 3,
        state: "final",
        message: { text: "hello" },
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 4,
        state: "delta",
        message: { text: "ignored" },
      },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(submitInboundMessage).not.toHaveBeenCalled();
  });

  it("forwards reply chunks even when raw gateway event forwarding is enabled", async () => {
    vi.useFakeTimers();
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const forward = createGatewayEventForwarder({
      relayInstanceId: "relay_1",
      backend: { submitInboundMessage } as never,
      forwardFinalOnly: false,
      getChatRunTrace: (runId) =>
        runId === "run_1"
          ? {
              backendMessageId: "msg_1",
            }
          : null,
    });

    await forward({
      type: "event",
      event: "chat",
      payload: {
        runId: "run_1",
        sessionKey: "session_1",
        seq: 1,
        state: "delta",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
      seq: 1,
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(submitInboundMessage).toHaveBeenCalledTimes(2);
    expect(submitInboundMessage.mock.calls[0]?.[0]).toMatchObject({
      body: {
        outcome: "technical",
        technical: {
          event: "chat",
        },
      },
    });
    expect(submitInboundMessage.mock.calls[1]?.[0]).toMatchObject({
      body: {
        outcome: "reply_chunk",
        replyChunk: {
          text: "hello",
          runId: "run_1",
          seq: 1,
        },
      },
    });
  });
});
