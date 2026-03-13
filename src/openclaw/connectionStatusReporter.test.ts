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
  it("throttles repeated disconnected reports to once per minute", async () => {
    const submitOpenclawStatus = vi.fn<SubmitOpenclawStatus>().mockResolvedValue({ accepted: true });
    const report = createOpenclawConnectionStatusReporter({
      backend: { submitOpenclawStatus } as never,
      relayInstanceId: "relay-1",
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
});
