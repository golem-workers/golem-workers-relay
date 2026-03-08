import { randomUUID } from "node:crypto";
import { type BackendClient } from "../backend/backendClient.js";
import { logger } from "../logger.js";
import { chatEventSchema, type EventFrame } from "./protocol.js";

type ChatRunTrace = {
  backendMessageId: string;
};

export function createGatewayEventForwarder(input: {
  relayInstanceId: string;
  backend: BackendClient;
  forwardFinalOnly: boolean;
  getChatRunTrace: (runId: string) => ChatRunTrace | null;
}): (evt: EventFrame) => Promise<void> {
  const { relayInstanceId, backend, forwardFinalOnly, getChatRunTrace } = input;
  return async (evt: EventFrame): Promise<void> => {
    if (!forwardFinalOnly) {
      await submitTechnicalEvent({
        relayInstanceId,
        backend,
        technicalEvent: evt.event,
        technicalPayload: evt.payload ?? null,
        seq: evt.seq ?? null,
        stateVersion: evt.stateVersion ?? null,
        openclawMeta: {
          method: `gateway.event.${evt.event}`,
          trace: {
            relayInstanceId,
          },
        },
      });
      return;
    }

    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success || parsed.data.state !== "delta") return;
    const runTrace = getChatRunTrace(parsed.data.runId);
    if (!runTrace) {
      logger.warn(
        { relayInstanceId, runId: parsed.data.runId, sessionKey: parsed.data.sessionKey, seq: parsed.data.seq },
        "Skipping OpenClaw delta signal without correlated backend message"
      );
      return;
    }

    await submitTechnicalEvent({
      relayInstanceId,
      backend,
      technicalEvent: "chat.delta_signal",
      technicalPayload: {
        runId: parsed.data.runId,
        sessionKey: parsed.data.sessionKey,
        seq: parsed.data.seq,
        state: parsed.data.state,
      },
      seq: evt.seq ?? parsed.data.seq,
      stateVersion: evt.stateVersion ?? null,
      openclawMeta: {
        method: "gateway.event.chat.delta_signal",
        runId: parsed.data.runId,
        trace: {
          backendMessageId: runTrace.backendMessageId,
          relayInstanceId,
          openclawRunId: parsed.data.runId,
        },
      },
    });
  };
}

async function submitTechnicalEvent(input: {
  relayInstanceId: string;
  backend: BackendClient;
  technicalEvent: string;
  technicalPayload: unknown;
  seq: number | null;
  stateVersion: unknown;
  openclawMeta: {
    method: string;
    runId?: string;
    trace: {
      backendMessageId?: string;
      relayInstanceId: string;
      openclawRunId?: string;
    };
  };
}): Promise<void> {
  const relayMessageId = `relay_oc_evt_${randomUUID()}`;
  const finishedAtMs = Date.now();
  try {
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId,
        finishedAtMs,
        outcome: "technical",
        technical: {
          source: "openclaw_gateway",
          event: input.technicalEvent,
          payload: input.technicalPayload,
          seq: input.seq,
          stateVersion: input.stateVersion,
        },
        openclawMeta: {
          method: input.openclawMeta.method,
          ...(input.openclawMeta.runId ? { runId: input.openclawMeta.runId } : {}),
          trace: {
            ...(input.openclawMeta.trace.backendMessageId
              ? { backendMessageId: input.openclawMeta.trace.backendMessageId }
              : {}),
            relayMessageId,
            relayInstanceId: input.openclawMeta.trace.relayInstanceId,
            ...(input.openclawMeta.trace.openclawRunId
              ? { openclawRunId: input.openclawMeta.trace.openclawRunId }
              : {}),
          },
        },
      },
    });
  } catch (err) {
    logger.warn(
      {
        event: "message_flow",
        direction: "relay_to_backend",
        stage: "failed",
        relayMessageId,
        relayInstanceId: input.relayInstanceId,
        outcome: "technical",
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to forward OpenClaw gateway event to backend"
    );
  }
}
