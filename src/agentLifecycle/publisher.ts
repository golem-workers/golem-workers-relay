import { logger } from "../logger.js";
import {
  AgentLifecycleBackendHttpError,
  type AgentLifecycleBackend,
} from "./backendClient.js";
import type { AgentLifecycleEvent } from "./contract.js";
import type { AgentLifecycleOutbox } from "./outbox.js";

export type AgentLifecycleDrainResult = Readonly<{
  acknowledged: number;
  pending: number;
  blocked: boolean;
  anomaly?: "SEQUENCE_GAP" | "GENERATION_CONFLICT";
}>;

export type AgentLifecyclePublisher = {
  publish(event: AgentLifecycleEvent): Promise<AgentLifecycleDrainResult>;
  drain(): Promise<AgentLifecycleDrainResult>;
};

export function createAgentLifecyclePublisher(input: {
  backend: AgentLifecycleBackend;
  outbox: AgentLifecycleOutbox;
}): AgentLifecyclePublisher {
  let serial: Promise<unknown> = Promise.resolve();

  const runSerial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation, operation);
    serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const drain = async (): Promise<AgentLifecycleDrainResult> => {
    let acknowledged = 0;
    const entries = await input.outbox.list();
    for (const entry of entries) {
      try {
        await input.backend.submitEvent(entry.event);
        await input.outbox.acknowledge(entry);
        acknowledged += 1;
      } catch (error) {
        const generationConflict =
          error instanceof AgentLifecycleBackendHttpError &&
          error.status === 409 &&
          [
            "AGENT_LIFECYCLE_TRANSITION_CONFLICT",
            "AGENT_LIFECYCLE_IDEMPOTENCY_CONFLICT",
          ].includes(error.code ?? "");
        const permanent =
          error instanceof AgentLifecycleBackendHttpError &&
          ([400, 422].includes(error.status) || generationConflict);
        if (permanent) {
          await input.outbox.quarantine(
            entry,
            `backend rejected event with HTTP ${error.status}`,
          );
          logger.error(
            {
              event: "agent_lifecycle_outbox_rejected",
              eventId: entry.event.eventId,
              status: error.status,
            },
            "Agent lifecycle event quarantined",
          );
        }
        if (permanent && !generationConflict) {
          continue;
        }
        const pending = (await input.outbox.list()).length;
        return {
          acknowledged,
          pending,
          blocked: true,
          ...(generationConflict
            ? { anomaly: "GENERATION_CONFLICT" as const }
            : error instanceof AgentLifecycleBackendHttpError &&
                error.code === "AGENT_LIFECYCLE_SEQUENCE_GAP"
              ? { anomaly: "SEQUENCE_GAP" as const }
              : {}),
        };
      }
    }
    return {
      acknowledged,
      pending: (await input.outbox.list()).length,
      blocked: false,
    };
  };

  return {
    publish(event) {
      return runSerial(async () => {
        await input.outbox.enqueue(event);
        return drain();
      });
    },
    drain() {
      return runSerial(drain);
    },
  };
}
