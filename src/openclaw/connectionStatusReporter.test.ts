import { describe, expect, it, vi } from "vitest";
import { createOpenclawConnectionStatusReporter } from "./connectionStatusReporter.js";

type SubmitOpenclawStatus = (input: {
  body: {
    relayInstanceId: string;
    observedAtMs: number;
    status: "CONNECTED" | "DISCONNECTED";
    reason?: string;
  };
}) => Promise<{ accepted: true }>;

describe("createOpenclawConnectionStatusReporter", () => {
  it("suppresses initial disconnected report when the gateway connects within grace", async () => {
    vi.useFakeTimers();
    try {
      const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
      const report = createOpenclawConnectionStatusReporter({
        backend: { submitOpenclawStatus } as never,
        relayInstanceId: "relay-1",
        initialDisconnectedReportGraceMs: 10_000,
      });

      await report({
        connected: false,
        reason: "Gateway websocket closed (1006)",
        observedAtMs: 1_741_850_800_000,
      });
      await vi.advanceTimersByTimeAsync(9_000);

      expect(submitOpenclawStatus).not.toHaveBeenCalled();

      await report({
        connected: true,
        observedAtMs: 1_741_850_808_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(submitOpenclawStatus).toHaveBeenCalledTimes(1);
      expect(submitOpenclawStatus).toHaveBeenCalledWith({
        body: {
          relayInstanceId: "relay-1",
          observedAtMs: 1_741_850_808_000,
          status: "CONNECTED",
          reason: undefined,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports initial disconnected after grace if the gateway stays down", async () => {
    vi.useFakeTimers();
    try {
      const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
      const report = createOpenclawConnectionStatusReporter({
        backend: { submitOpenclawStatus } as never,
        relayInstanceId: "relay-1",
        initialDisconnectedReportGraceMs: 10_000,
      });

      await report({
        connected: false,
        reason: "Relay-channel control plane disconnected",
        observedAtMs: 1_741_850_800_000,
      });
      await report({
        connected: false,
        reason: "Gateway websocket closed (1006)",
        observedAtMs: 1_741_850_800_050,
      });

      expect(submitOpenclawStatus).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(submitOpenclawStatus).toHaveBeenCalledTimes(1);
      expect(submitOpenclawStatus).toHaveBeenCalledWith({
        body: {
          relayInstanceId: "relay-1",
          observedAtMs: 1_741_850_800_050,
          status: "DISCONNECTED",
          reason: "Gateway websocket closed (1006)",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throttles repeated disconnected reports to once per minute", async () => {
    const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
    const report = createOpenclawConnectionStatusReporter({
      backend: { submitOpenclawStatus } as never,
      relayInstanceId: "relay-1",
      initialDisconnectedReportGraceMs: 0,
    });

    await report({
      connected: false,
      reason: "Gateway websocket closed (1006)",
      observedAtMs: 1_741_850_800_000,
    });
    await report({
      connected: false,
      reason: "Gateway websocket closed (1006)",
      observedAtMs: 1_741_850_830_000,
    });
    await report({
      connected: false,
      reason: "Gateway websocket closed (1006)",
      observedAtMs: 1_741_850_861_000,
    });

    expect(submitOpenclawStatus).toHaveBeenCalledTimes(2);
    expect(submitOpenclawStatus).toHaveBeenNthCalledWith(1, {
      body: {
        relayInstanceId: "relay-1",
        observedAtMs: 1_741_850_800_000,
        status: "DISCONNECTED",
        reason: "Gateway websocket closed (1006)",
      },
    });
    expect(submitOpenclawStatus).toHaveBeenNthCalledWith(2, {
      body: {
        relayInstanceId: "relay-1",
        observedAtMs: 1_741_850_861_000,
        status: "DISCONNECTED",
        reason: "Gateway websocket closed (1006)",
      },
    });
  });

  it("reports restored connection immediately after a disconnect", async () => {
    const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
    const report = createOpenclawConnectionStatusReporter({
      backend: { submitOpenclawStatus } as never,
      relayInstanceId: "relay-1",
      initialDisconnectedReportGraceMs: 0,
    });

    await report({
      connected: false,
      reason: "Gateway websocket closed (1006)",
      observedAtMs: 1_741_850_800_000,
    });
    await report({
      connected: true,
      observedAtMs: 1_741_850_801_000,
    });

    expect(submitOpenclawStatus).toHaveBeenNthCalledWith(2, {
      body: {
        relayInstanceId: "relay-1",
        observedAtMs: 1_741_850_801_000,
        status: "CONNECTED",
        reason: undefined,
      },
    });
  });

  it("reports delivery snapshot changes while gateway stays connected", async () => {
    const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
    let relayChannelConnected = false;
    const report = createOpenclawConnectionStatusReporter({
      backend: { submitOpenclawStatus } as never,
      relayInstanceId: "relay-1",
      buildDeliveryReport: () => ({
        modeEffective: "relay_channel_v2",
        relayChannelReady: true,
        relayChannelConnected,
      }),
    });

    await report({
      connected: true,
      observedAtMs: 1_741_850_800_000,
    });
    relayChannelConnected = true;
    await report({
      connected: true,
      observedAtMs: 1_741_850_801_000,
    });

    expect(submitOpenclawStatus).toHaveBeenCalledTimes(2);
    expect(submitOpenclawStatus).toHaveBeenNthCalledWith(1, {
      body: {
        relayInstanceId: "relay-1",
        observedAtMs: 1_741_850_800_000,
        status: "CONNECTED",
        reason: undefined,
        delivery: {
          modeEffective: "relay_channel_v2",
          relayChannelReady: true,
          relayChannelConnected: false,
        },
      },
    });
    expect(submitOpenclawStatus).toHaveBeenNthCalledWith(2, {
      body: {
        relayInstanceId: "relay-1",
        observedAtMs: 1_741_850_801_000,
        status: "CONNECTED",
        reason: undefined,
        delivery: {
          modeEffective: "relay_channel_v2",
          relayChannelReady: true,
          relayChannelConnected: true,
        },
      },
    });
  });
});
