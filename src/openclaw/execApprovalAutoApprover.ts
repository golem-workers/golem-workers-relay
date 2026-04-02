import { logger } from "../logger.js";
import { type EventFrame, type HelloOk } from "./protocol.js";

const REQUIRED_GATEWAY_METHODS = ["exec.approval.resolve"] as const;
const LOCAL_EXEC_APPROVAL_HOSTS = new Set(["sandbox", "gateway"]);

type GatewayLike = {
  isReady(): boolean;
  request(method: string, params?: unknown): Promise<unknown>;
};

type PendingExecApprovalRequest = {
  id: string;
  request: {
    command: string | null;
    cwd: string | null;
    host: string | null;
    nodeId: string | null;
    agentId: string | null;
    security: string | null;
    ask: string | null;
  };
  createdAtMs: number | null;
  expiresAtMs: number | null;
};

export function createExecApprovalAutoApprover(input: {
  gateway: GatewayLike;
}) {
  const gateway = input.gateway;
  const inFlight = new Set<string>();
  let gatewaySupported = true;
  let stopped = false;

  function start(): void {
    logger.info(
      { event: "exec_approval_auto_approve" },
      "Relay local exec approval auto-approve enabled"
    );
  }

  function stop(): void {
    stopped = true;
    inFlight.clear();
  }

  function handleHello(hello: HelloOk): void {
    const methods = hello.features?.methods;
    if (!Array.isArray(methods) || methods.length === 0) {
      gatewaySupported = true;
      return;
    }
    gatewaySupported = REQUIRED_GATEWAY_METHODS.every((method) => methods.includes(method));
    if (!gatewaySupported) {
      logger.warn(
        {
          event: "exec_approval_auto_approve",
          missingMethods: REQUIRED_GATEWAY_METHODS.filter((method) => !methods.includes(method)),
        },
        "Relay disabled local exec approval auto-approve because gateway methods are unavailable"
      );
    }
  }

  function handleEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.resolved") {
      const resolvedId = normalizeResolvedApprovalId(evt.payload);
      if (resolvedId) {
        inFlight.delete(resolvedId);
      }
      return;
    }
    if (evt.event !== "exec.approval.requested") {
      return;
    }
    void maybeApprove(evt.payload);
  }

  async function maybeApprove(payload: unknown): Promise<void> {
    if (stopped || !gatewaySupported || !gateway.isReady()) {
      return;
    }
    const request = normalizePendingExecApprovalRequest(payload);
    if (!request || !isEligibleLocalExecApprovalRequest(request)) {
      return;
    }
    if (inFlight.has(request.id)) {
      return;
    }
    inFlight.add(request.id);
    try {
      await gateway.request("exec.approval.resolve", {
        id: request.id,
        decision: "allow-once",
      });
      logger.info(
        {
          event: "exec_approval_auto_approve",
          stage: "approved",
          id: request.id,
          host: request.request.host,
          agentId: request.request.agentId,
          cwd: request.request.cwd,
          security: request.request.security,
          ask: request.request.ask,
          expiresAtMs: request.expiresAtMs,
        },
        "Relay auto-approved local exec approval request"
      );
    } catch (error) {
      logger.warn(
        {
          event: "exec_approval_auto_approve",
          stage: "approve_failed",
          id: request.id,
          host: request.request.host,
          agentId: request.request.agentId,
          cwd: request.request.cwd,
          security: request.request.security,
          ask: request.request.ask,
          err: error instanceof Error ? error.message : String(error),
        },
        "Relay failed to auto-approve local exec approval request"
      );
    } finally {
      inFlight.delete(request.id);
    }
  }

  return {
    start,
    stop,
    handleHello,
    handleEvent,
  };
}

export function isEligibleLocalExecApprovalRequest(input: PendingExecApprovalRequest): boolean {
  return (
    input.id.length > 0 &&
    typeof input.request.command === "string" &&
    input.request.command.trim().length > 0 &&
    typeof input.request.host === "string" &&
    LOCAL_EXEC_APPROVAL_HOSTS.has(input.request.host) &&
    input.request.nodeId === null
  );
}

function normalizePendingExecApprovalRequest(input: unknown): PendingExecApprovalRequest | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const item = input as Record<string, unknown>;
  const id = readNonEmptyString(item.id);
  const request = item.request;
  if (!id || !request || typeof request !== "object") {
    return null;
  }
  const requestRecord = request as Record<string, unknown>;
  return {
    id,
    request: {
      command: readNonEmptyString(requestRecord.command),
      cwd: readNonEmptyString(requestRecord.cwd),
      host: readNonEmptyString(requestRecord.host),
      nodeId: readNonEmptyString(requestRecord.nodeId),
      agentId: readNonEmptyString(requestRecord.agentId),
      security: readNonEmptyString(requestRecord.security),
      ask: readNonEmptyString(requestRecord.ask),
    },
    createdAtMs: readFiniteNumber(item.createdAtMs),
    expiresAtMs: readFiniteNumber(item.expiresAtMs),
  };
}

function normalizeResolvedApprovalId(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  return readNonEmptyString((input as Record<string, unknown>).id);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
