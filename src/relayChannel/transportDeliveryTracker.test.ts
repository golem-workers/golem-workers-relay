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

    expect(tracker.getSdkDelivery("msg_1")).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "tg-1",
    });
    expect(tracker.getSdkDelivery("msg_2")).toBeNull();
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
