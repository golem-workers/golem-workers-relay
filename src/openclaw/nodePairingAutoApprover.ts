import { logger } from "../logger.js";
import { type EventFrame, type HelloOk } from "./protocol.js";

const AUTO_APPROVE_SWEEP_INTERVAL_MS = 5_000;
const REQUIRED_GATEWAY_METHODS = ["node.pair.list", "node.pair.approve"] as const;
const CONNECTOR_NODE_PLATFORMS = new Set(["macos", "windows", "linux"]);

type GatewayLike = {
  isReady(): boolean;
  request(method: string, params?: unknown): Promise<unknown>;
};

type PendingNodePairingRequest = {
  requestId: string;
  nodeId: string | null;
  platform: string | null;
  caps: string[];
  commands: string[];
};

export function createNodePairingAutoApprover(input: {
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
    logger.info({ event: "node_pair_auto_approve", sweepIntervalMs }, "Relay internal node-pair auto-approve enabled");
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
          event: "node_pair_auto_approve",
          missingMethods: REQUIRED_GATEWAY_METHODS.filter((method) => !methods.includes(method)),
        },
        "Relay disabled internal node-pair auto-approve because gateway methods are unavailable",
      );
      return;
    }
    void triggerSweep("hello");
  }

  function handleEvent(evt: EventFrame): void {
    if (evt.event !== "node.pair.requested") {
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
      payload = await gateway.request("node.pair.list", {});
    } catch (error) {
      logger.warn(
        {
          event: "node_pair_auto_approve",
          stage: "list_failed",
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        "Relay failed to list node pairing requests",
      );
      return;
    }

    const eligibleRequests = listPendingNodePairingRequests(payload).filter(isEligibleConnectorNodePairingRequest);
    if (eligibleRequests.length === 0) {
      return;
    }

    logger.info(
      {
        event: "node_pair_auto_approve",
        stage: "eligible_requests_detected",
        reason,
        requestIds: eligibleRequests.map((item) => item.requestId),
        nodeIds: Array.from(new Set(eligibleRequests.map((item) => item.nodeId).filter(Boolean))),
      },
      "Relay found connector node pairing requests eligible for auto-approve",
    );

    for (const request of eligibleRequests) {
      try {
        await gateway.request("node.pair.approve", { requestId: request.requestId });
        logger.info(
          {
            event: "node_pair_auto_approve",
            stage: "approved",
            reason,
            requestId: request.requestId,
            nodeId: request.nodeId,
            platform: request.platform,
            commands: request.commands,
          },
          "Relay auto-approved connector node pairing request",
        );
      } catch (error) {
        logger.warn(
          {
            event: "node_pair_auto_approve",
            stage: "approve_failed",
            reason,
            requestId: request.requestId,
            nodeId: request.nodeId,
            platform: request.platform,
            commands: request.commands,
            err: error instanceof Error ? error.message : String(error),
          },
          "Relay failed to auto-approve connector node pairing request",
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

export function isEligibleConnectorNodePairingRequest(input: PendingNodePairingRequest): boolean {
  if (!input.requestId || !input.nodeId) {
    return false;
  }
  const platform = input.platform?.trim().toLowerCase() ?? "";
  if (!CONNECTOR_NODE_PLATFORMS.has(platform)) {
    return false;
  }
  if (!input.caps.includes("browser")) {
    return false;
  }
  return input.commands.includes("browser.proxy");
}

function listPendingNodePairingRequests(payload: unknown): PendingNodePairingRequest[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const pending = (payload as { pending?: unknown }).pending;
  if (!Array.isArray(pending)) {
    return [];
  }
  return pending
    .map((item) => normalizePendingNodePairingRequest(item))
    .filter((item): item is PendingNodePairingRequest => item !== null);
}

function normalizePendingNodePairingRequest(input: unknown): PendingNodePairingRequest | null {
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
    nodeId: readNonEmptyString(item.nodeId),
    platform: readNonEmptyString(item.platform),
    caps: readStringArray(item.caps),
    commands: readStringArray(item.commands),
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
