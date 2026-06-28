import { logger } from "../logger.js";
import { type BackendClient } from "../backend/backendClient.js";

const DISCONNECTED_REPORT_THROTTLE_MS = 60_000;
const INITIAL_DISCONNECTED_REPORT_GRACE_MS = 10_000;

type ConnectionStateReport = {
  connected: boolean;
  reason?: string;
  observedAtMs: number;
};

type PendingDisconnectedReport = {
  timer: ReturnType<typeof setTimeout>;
  state: ConnectionStateReport;
  delivery: Record<string, unknown> | undefined;
  deliveryKey: string;
};

export function createOpenclawConnectionStatusReporter(input: {
  backend: BackendClient;
  relayInstanceId: string;
  buildDeliveryReport?: () => Record<string, unknown>;
  initialDisconnectedReportGraceMs?: number;
}) {
  let lastSentConnected: boolean | null = null;
  let lastSentDeliveryKey: string | null = null;
  let lastDisconnectedReportedAtMs = 0;
  let pendingInitialDisconnected: PendingDisconnectedReport | null = null;

  const initialDisconnectedReportGraceMs = Math.max(
    0,
    Math.trunc(input.initialDisconnectedReportGraceMs ?? INITIAL_DISCONNECTED_REPORT_GRACE_MS)
  );

  function clearPendingInitialDisconnected(): void {
    if (!pendingInitialDisconnected) return;
    clearTimeout(pendingInitialDisconnected.timer);
    pendingInitialDisconnected = null;
  }

  async function sendReport(
    state: ConnectionStateReport,
    delivery: Record<string, unknown> | undefined,
    deliveryKey: string
  ): Promise<void> {
    if (state.connected) {
      clearPendingInitialDisconnected();
    }

    if (!state.connected) {
      const withinThrottleWindow =
        lastSentConnected === false &&
        lastSentDeliveryKey === deliveryKey &&
        state.observedAtMs - lastDisconnectedReportedAtMs < DISCONNECTED_REPORT_THROTTLE_MS;
      if (withinThrottleWindow) {
        return;
      }
    } else if (lastSentConnected === true && lastSentDeliveryKey === deliveryKey) {
      return;
    }

    try {
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
      lastSentDeliveryKey = deliveryKey;
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
  }

  return async function report(state: ConnectionStateReport): Promise<void> {
    const delivery = input.buildDeliveryReport?.();
    const deliveryKey = JSON.stringify(delivery ?? null);

    if (!state.connected && lastSentConnected === null && initialDisconnectedReportGraceMs > 0) {
      if (pendingInitialDisconnected) {
        pendingInitialDisconnected.state = {
          ...state,
          reason: state.reason ?? pendingInitialDisconnected.state.reason,
        };
        pendingInitialDisconnected.delivery = delivery;
        pendingInitialDisconnected.deliveryKey = deliveryKey;
        return;
      }

      pendingInitialDisconnected = {
        state,
        delivery,
        deliveryKey,
        timer: setTimeout(() => {
          const pending = pendingInitialDisconnected;
          pendingInitialDisconnected = null;
          if (!pending) return;
          void sendReport(pending.state, pending.delivery, pending.deliveryKey);
        }, initialDisconnectedReportGraceMs),
      };
      return;
    }

    await sendReport(state, delivery, deliveryKey);
  };
}
