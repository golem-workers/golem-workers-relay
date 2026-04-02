import { logger } from "../logger.js";
import { type EventFrame, type HelloOk } from "./protocol.js";

const AUTO_APPROVE_SWEEP_INTERVAL_MS = 5_000;
const REQUIRED_GATEWAY_METHODS = ["device.pair.list", "device.pair.approve"] as const;

type GatewayLike = {
  isReady(): boolean;
  request(method: string, params?: unknown): Promise<unknown>;
};

type PendingDevicePairingRequest = {
  requestId: string;
  deviceId: string | null;
  clientId: string | null;
  clientMode: string | null;
  role: string | null;
  scopes: string[];
};

export function createDevicePairingAutoApprover(input: {
  gateway: GatewayLike;
  sweepIntervalMs?: number;
}) {
  const gateway = input.gateway;
  const sweepIntervalMs = Math.max(1_000, Math.trunc(input.sweepIntervalMs ?? AUTO_APPROVE_SWEEP_INTERVAL_MS));
  let interval: NodeJS.Timeout | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let gatewaySupported = true;
  let stopped = false;

  function start(): void {
    if (interval) {
      return;
    }
    logger.info({ event: "device_pair_auto_approve", sweepIntervalMs }, "Relay internal device-pair auto-approve enabled");
    interval = setInterval(() => {
      void triggerSweep("interval");
    }, sweepIntervalMs);
  }

  function stop(): void {
    stopped = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function handleHello(hello: HelloOk): void {
    const methods = hello.features?.methods;
    if (!Array.isArray(methods) || methods.length === 0) {
      gatewaySupported = true;
      void triggerSweep("hello");
      return;
    }
    gatewaySupported = REQUIRED_GATEWAY_METHODS.every((method) => methods.includes(method));
    if (!gatewaySupported) {
      logger.warn(
        {
          event: "device_pair_auto_approve",
          missingMethods: REQUIRED_GATEWAY_METHODS.filter((method) => !methods.includes(method)),
        },
        "Relay disabled internal device-pair auto-approve because gateway methods are unavailable"
      );
      return;
    }
    void triggerSweep("hello");
  }

  function handleEvent(evt: EventFrame): void {
    if (evt.event !== "device.pair.requested") {
      return;
    }
    void triggerSweep("event");
  }

  async function triggerSweep(reason: "hello" | "event" | "interval" | "manual"): Promise<void> {
    if (stopped || !gatewaySupported || !gateway.isReady()) {
      return;
    }
    if (sweepInFlight) {
      await sweepInFlight;
      return;
    }
    sweepInFlight = runSweep(reason).finally(() => {
      sweepInFlight = null;
    });
    await sweepInFlight;
  }

  async function runSweep(reason: "hello" | "event" | "interval" | "manual"): Promise<void> {
    let payload: unknown;
    try {
      payload = await gateway.request("device.pair.list", {});
    } catch (error) {
      logger.warn(
        {
          event: "device_pair_auto_approve",
          stage: "list_failed",
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        "Relay failed to list device pairing requests"
      );
      return;
    }

    const eligibleRequests = listPendingDevicePairingRequests(payload).filter(isEligibleInternalPairingRequest);
    if (eligibleRequests.length === 0) {
      return;
    }

    logger.info(
      {
        event: "device_pair_auto_approve",
        stage: "eligible_requests_detected",
        reason,
        requestIds: eligibleRequests.map((item) => item.requestId),
        clientIds: Array.from(new Set(eligibleRequests.map((item) => item.clientId).filter(Boolean))),
      },
      "Relay found internal device pairing requests eligible for auto-approve"
    );

    for (const request of eligibleRequests) {
      try {
        await gateway.request("device.pair.approve", { requestId: request.requestId });
        logger.info(
          {
            event: "device_pair_auto_approve",
            stage: "approved",
            reason,
            requestId: request.requestId,
            deviceId: request.deviceId,
            clientId: request.clientId,
            scopes: request.scopes,
          },
          "Relay auto-approved internal device pairing request"
        );
      } catch (error) {
        logger.warn(
          {
            event: "device_pair_auto_approve",
            stage: "approve_failed",
            reason,
            requestId: request.requestId,
            deviceId: request.deviceId,
            clientId: request.clientId,
            scopes: request.scopes,
            err: error instanceof Error ? error.message : String(error),
          },
          "Relay failed to auto-approve internal device pairing request"
        );
      }
    }
  }

  return {
    start,
    stop,
    handleHello,
    handleEvent,
    sweepNow: () => triggerSweep("manual"),
  };
}

export function isEligibleInternalPairingRequest(input: PendingDevicePairingRequest): boolean {
  return (
    input.requestId.length > 0 &&
    input.clientId === "gateway-client" &&
    input.clientMode === "backend" &&
    input.role === "operator" &&
    input.scopes.length > 0 &&
    input.scopes.every((scope) => scope.startsWith("operator."))
  );
}

function listPendingDevicePairingRequests(payload: unknown): PendingDevicePairingRequest[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const pending = (payload as { pending?: unknown }).pending;
  if (!Array.isArray(pending)) {
    return [];
  }
  return pending
    .map((item) => normalizePendingDevicePairingRequest(item))
    .filter((item): item is PendingDevicePairingRequest => item !== null);
}

function normalizePendingDevicePairingRequest(input: unknown): PendingDevicePairingRequest | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const item = input as Record<string, unknown>;
  const requestId = readNonEmptyString(item.requestId);
  if (!requestId) {
    return null;
  }
  return {
    requestId,
    deviceId: readNonEmptyString(item.deviceId),
    clientId: readNonEmptyString(item.clientId),
    clientMode: readNonEmptyString(item.clientMode),
    role: readNonEmptyString(item.role),
    scopes: readStringArray(item.scopes),
  };
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => readNonEmptyString(item)).filter((item): item is string => item !== null);
}
