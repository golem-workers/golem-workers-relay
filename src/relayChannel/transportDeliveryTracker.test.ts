import { describe, expect, it } from "vitest";
import {
  createRelayChannelTransportDeliveryTracker,
  readTransportDeliveryCorrelationId,
} from "./transportDeliveryTracker.js";

describe("transportDeliveryTracker", () => {
  it("records and reads SDK deliveries by correlation id", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.recordSdkDelivery({
      correlationMessageId: "msg_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-1",
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-1",
    });
    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_2" })).toBeNull();
  });

  it("records and clears SDK deliveries by session key", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });
    tracker.recordSdkDelivery({
      sessionKey: "tg:123:srv_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-session-1",
    });

    expect(tracker.getSdkDelivery({ sessionKey: "tg:123:srv_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-session-1",
    });
    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-session-1",
    });

    tracker.clear({ sessionKey: "tg:123:srv_1" });

    expect(tracker.getSdkDelivery({ sessionKey: "tg:123:srv_1" })).toBeNull();
  });

  it("prefers correlationMessageId over backendMessageId", () => {
    expect(
      readTransportDeliveryCorrelationId({
        backendMessageId: "backend_1",
        correlationMessageId: "corr_1",
      })
    ).toBe("corr_1");
  });
});
