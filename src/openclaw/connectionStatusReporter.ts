import { logger } from "../logger.js";
import { type BackendClient } from "../backend/backendClient.js";

const DISCONNECTED_REPORT_THROTTLE_MS = 60_000;

export function createOpenclawConnectionStatusReporter(input: {
  backend: BackendClient;
  relayInstanceId: string;
  buildDeliveryReport?: () => Record<string, unknown>;
}) {
  let lastSentConnected: boolean | null = null;
  let lastDisconnectedReportedAtMs = 0;

  return async function report(state: {
    connected: boolean;
    reason?: string;
    observedAtMs: number;
  }): Promise<void> {
    if (!state.connected) {
      const withinThrottleWindow =
        lastSentConnected === false &&
        state.observedAtMs - lastDisconnectedReportedAtMs < DISCONNECTED_REPORT_THROTTLE_MS;
      if (withinThrottleWindow) {
        return;
      }
    } else if (lastSentConnected === true) {
      return;
    }

    try {
      const delivery = input.buildDeliveryReport?.();
      await input.backend.submitOpenclawStatus({
        body: {
          relayInstanceId: input.relayInstanceId,
          observedAtMs: state.observedAtMs,
          status: state.connected ? "CONNECTED" : "DISCONNECTED",
          reason: state.connected ? undefined : state.reason,
          ...(delivery ? { delivery } : {}),
        },
      });
      lastSentConnected = state.connected;
      if (!state.connected) {
        lastDisconnectedReportedAtMs = state.observedAtMs;
      }
    } catch (error) {
      logger.warn(
        {
          connected: state.connected,
          reason: state.reason ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to report OpenClaw connection status to backend"
      );
    }
  };
}
