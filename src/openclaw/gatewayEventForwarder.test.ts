import { describe, expect, it, vi } from "vitest";
import { createGatewayEventForwarder } from "./gatewayEventForwarder.js";

describe("createGatewayEventForwarder", () => {
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

  it("sends only compact delta signals in final-only mode", async () => {
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
      event: "tick",
      payload: { ts: 1 },
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

    expect(submitInboundMessage).toHaveBeenCalledTimes(1);
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
  });
});
