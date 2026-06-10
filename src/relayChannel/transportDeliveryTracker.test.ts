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

  it("records unscoped SDK deliveries against the sole active session", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });

    tracker.recordSdkDelivery({
      transportChannelId: "telegram",
      transportMessageId: "tg-unscoped-1",
      allowUnscopedActiveFallback: true,
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-unscoped-1",
    });
    expect(tracker.getSdkDelivery({ sessionKey: "tg:123:srv_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-unscoped-1",
    });
  });

  it("does not guess unscoped SDK delivery when multiple sessions are active", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });
    tracker.begin({
      correlationMessageId: "msg_2",
      sessionKey: "tg:456:srv_1",
    });

    tracker.recordSdkDelivery({
      transportChannelId: "telegram",
      transportMessageId: "tg-unscoped-1",
      allowUnscopedActiveFallback: true,
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toBeNull();
    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_2" })).toBeNull();
  });

  it("does not guess session-scoped SDK delivery when multiple messages are active in the same session", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });
    tracker.begin({
      correlationMessageId: "msg_2",
      sessionKey: "tg:123:srv_1",
    });

    tracker.recordSdkDelivery({
      sessionKey: "tg:123:srv_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-ambiguous",
      allowUnscopedActiveFallback: true,
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toBeNull();
    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_2" })).toBeNull();
    expect(tracker.getSdkDelivery({ sessionKey: "tg:123:srv_1" })).toBeNull();
  });

  it("still records explicitly correlated delivery when multiple messages are active in the same session", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });
    tracker.begin({
      correlationMessageId: "msg_2",
      sessionKey: "tg:123:srv_1",
    });

    tracker.recordSdkDelivery({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-explicit",
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-explicit",
    });
    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_2" })).toBeNull();
  });

  it("does not let fallback session delivery overwrite an explicit correlation receipt", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });
    tracker.recordSdkDelivery({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-explicit",
    });
    tracker.recordSdkDelivery({
      sessionKey: "tg:123:srv_1",
      transportChannelId: "telegram",
      transportMessageId: "tg-fallback-late",
      allowUnscopedActiveFallback: true,
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-explicit",
    });
    expect(tracker.getSdkDelivery({ sessionKey: "tg:123:srv_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-explicit",
    });
  });

  it("ignores unscoped SDK deliveries unless active fallback is explicitly allowed", () => {
    const tracker = createRelayChannelTransportDeliveryTracker();
    tracker.begin({
      correlationMessageId: "msg_1",
      sessionKey: "tg:123:srv_1",
    });

    tracker.recordSdkDelivery({
      transportChannelId: "telegram",
      transportMessageId: "tg-unscoped-1",
    });

    expect(tracker.getSdkDelivery({ correlationMessageId: "msg_1" })).toBeNull();
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
