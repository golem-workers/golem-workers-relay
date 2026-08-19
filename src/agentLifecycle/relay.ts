import { randomUUID } from "node:crypto";

import { logger } from "../logger.js";
import type { EventFrame } from "../openclaw/protocol.js";
import { AgentLifecycleTransitionEncoder } from "./adapter.js";
import type {
  AgentLifecycleBackend,
  AgentLifecycleGenerationResponse,
} from "./backendClient.js";
import { openClawLifecycleAdapter } from "./openclawAdapter.js";
import { observeOpenClawLifecycleFrame } from "./openclawObserver.js";
import type { AgentLifecycleOutbox } from "./outbox.js";
import type { AgentLifecyclePublisher } from "./publisher.js";
import {
  planAgentLifecycleReconciliation,
  type AgentLifecycleActiveRun,
} from "./reconciliation.js";
import type {
  AgentLifecycleSourceState,
  AgentLifecycleSourceStore,
} from "./sourceStore.js";

export type AgentLifecycleRelay = {
  handleGatewayEvent(frame: EventFrame): void;
  handleGatewayConnectionStateChange(state: { connected: boolean }): void;
  flush(): Promise<void>;
};

export function createAgentLifecycleRelay(input: {
  backend: AgentLifecycleBackend;
  outbox: AgentLifecycleOutbox;
  publisher: AgentLifecyclePublisher;
  sourceStore: AgentLifecycleSourceStore;
  queryActiveRuns?: () => Promise<AgentLifecycleActiveRun[]>;
  now?: () => Date;
  generationId?: () => string;
}): AgentLifecycleRelay {
  type ActivationTrigger =
    | "STARTUP_OR_RECONNECT"
    | "SEQUENCE_GAP"
    | "ANOMALY";
  const now = input.now ?? (() => new Date());
  const generationId = input.generationId ?? randomUUID;
  const retryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
  let current: AgentLifecycleSourceState | null = null;
  let connected = false;
  let initialized = false;
  let encoder = new AgentLifecycleTransitionEncoder();
  let serial: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let retryTrigger: ActivationTrigger | null = null;

  const enqueue = (operation: () => Promise<void>): void => {
    serial = serial.then(operation, operation).catch((error) => {
      logger.error(
        {
          event: "agent_lifecycle_relay_error",
          error: error instanceof Error ? error.message : String(error),
        },
        "Agent lifecycle relay operation failed",
      );
    });
  };

  const triggerPriority: Record<ActivationTrigger, number> = {
    STARTUP_OR_RECONNECT: 1,
    ANOMALY: 2,
    SEQUENCE_GAP: 3,
  };

  const scheduleActivationRetry = (trigger: ActivationTrigger): void => {
    if (
      !retryTrigger ||
      triggerPriority[trigger] > triggerPriority[retryTrigger]
    ) {
      retryTrigger = trigger;
    }
    if (retryTimer) return;
    const delay = retryDelaysMs[Math.min(retryAttempt, retryDelaysMs.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const nextTrigger = retryTrigger ?? "ANOMALY";
      retryTrigger = null;
      enqueue(() => activateGeneration(nextTrigger));
    }, delay);
    retryTimer.unref?.();
  };

  const markActivationConverged = (): void => {
    retryAttempt = 0;
    retryTrigger = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const registerCurrent = async (): Promise<AgentLifecycleGenerationResponse | null> => {
    if (!current) return null;
    try {
      const response = await input.backend.registerGeneration({
        sourceGeneration: current.sourceGeneration,
        registeredAt: current.updatedAt,
      });
      if (response.serverId !== current.serverId) {
        throw new Error("Authenticated lifecycle server identity changed");
      }
      current = { ...current, registered: true, updatedAt: now().toISOString() };
      await input.sourceStore.save(current);
      return response;
    } catch (error) {
      logger.warn(
        {
          event: "agent_lifecycle_generation_registration_failed",
          sourceGeneration: current.sourceGeneration,
          error: error instanceof Error ? error.message : String(error),
        },
        "Agent lifecycle generation registration deferred",
      );
      return null;
    }
  };

  const reconcile = async (
    response: AgentLifecycleGenerationResponse,
    trigger: ActivationTrigger,
  ): Promise<void> => {
    if (!current || !input.queryActiveRuns) return;
    try {
      const observed = await input.queryActiveRuns();
      const checkpoint = response.activeRuns.map((run) => ({
        provider: run.provider,
        ...(run.agentId ? { agentId: run.agentId } : {}),
        sessionId: run.sessionId,
        runId: run.runId,
        status: run.status,
      }));
      const corrections = planAgentLifecycleReconciliation({ checkpoint, observed });
      for (const correction of corrections) {
        const context = {
          serverId: current.serverId,
          ...(correction.run.agentId ? { agentId: correction.run.agentId } : {}),
          sessionId: correction.run.sessionId,
          runId: correction.run.runId,
          sourceGeneration: current.sourceGeneration,
          occurredAt: now().toISOString(),
          origin: "RECONCILIATION" as const,
        };
        if (correction.kind === "DISAPPEARED") {
          encoder.seedActiveRun(
            openClawLifecycleAdapter,
            context,
            correction.run.status,
          );
        }
        const event = encoder.observe(
          openClawLifecycleAdapter,
          correction.kind === "ACTIVE"
            ? {
                event: "active_run",
                hasActiveRun: true,
                waiting: correction.run.status === "WAITING",
              }
            : {
                event: "lifecycle",
                phase: "end",
                aborted: true,
                livenessState: "reconciliation_missing_active_run",
              },
          context,
        );
        if (event) await input.outbox.enqueue(event);
      }
      const result = await input.publisher.drain();
      if (result.anomaly === "SEQUENCE_GAP") {
        scheduleActivationRetry("SEQUENCE_GAP");
      } else if (result.pending > 0) {
        scheduleActivationRetry("ANOMALY");
      }
      logger.info(
        {
          event: "agent_lifecycle_reconciliation",
          trigger,
          observedCount: observed.length,
          checkpointCount: checkpoint.length,
          correctionCount: corrections.length,
          pending: result.pending,
        },
        "Agent lifecycle reconciliation completed",
      );
    } catch (error) {
      logger.warn(
        {
          event: "agent_lifecycle_reconciliation_failed",
          trigger,
          error: error instanceof Error ? error.message : String(error),
        },
        "Agent lifecycle reconciliation deferred",
      );
    }
  };

  const activateGeneration = async (
    requestedTrigger: ActivationTrigger = "STARTUP_OR_RECONNECT",
  ): Promise<void> => {
    let trigger = requestedTrigger;
    if (!initialized) {
      current = await input.sourceStore.load();
      initialized = true;
    }

    if (current && !current.registered) {
      const response = await registerCurrent();
      if (!response) {
        scheduleActivationRetry(trigger);
        return;
      }
      const replay = await input.publisher.drain();
      if (replay.anomaly === "SEQUENCE_GAP") {
        trigger = "SEQUENCE_GAP";
      } else if (replay.pending > 0) {
        scheduleActivationRetry(trigger);
        return;
      }
      markActivationConverged();
      await reconcile(response, trigger);
      return;
    }

    if (current) {
      const replay = await input.publisher.drain();
      if (replay.anomaly === "SEQUENCE_GAP") {
        trigger = "SEQUENCE_GAP";
      } else if (replay.pending > 0) {
        scheduleActivationRetry(trigger);
        return;
      }
    }

    const sourceGeneration = generationId();
    const updatedAt = now().toISOString();

    if (current?.serverId) {
      current = {
        schemaVersion: 1,
        serverId: current.serverId,
        sourceGeneration,
        registered: false,
        updatedAt,
      };
      await input.sourceStore.save(current);
      encoder = new AgentLifecycleTransitionEncoder();
      const response = await registerCurrent();
      if (response) {
        await input.publisher.drain();
        markActivationConverged();
        await reconcile(response, trigger);
      } else {
        scheduleActivationRetry(trigger);
      }
      return;
    }

    try {
      const response = await input.backend.registerGeneration({
        sourceGeneration,
        registeredAt: updatedAt,
      });
      current = {
        schemaVersion: 1,
        serverId: response.serverId,
        sourceGeneration,
        registered: true,
        updatedAt,
      };
      await input.sourceStore.save(current);
      encoder = new AgentLifecycleTransitionEncoder();
      await input.publisher.drain();
      markActivationConverged();
      await reconcile(response, trigger);
    } catch (error) {
      logger.warn(
        {
          event: "agent_lifecycle_generation_bootstrap_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "Agent lifecycle source identity unavailable",
      );
      scheduleActivationRetry(trigger);
    }
  };

  const processFrame = async (frame: EventFrame): Promise<void> => {
    const observation = observeOpenClawLifecycleFrame(frame);
    if (!observation) return;
    if (!current) {
      await activateGeneration();
    }
    if (!current) {
      logger.error(
        { event: "agent_lifecycle_event_not_persisted" },
        "Lifecycle event cannot be persisted before server identity bootstrap",
      );
      return;
    }

    const event = encoder.observe(openClawLifecycleAdapter, observation.signal, {
      serverId: current.serverId,
      ...(observation.agentId ? { agentId: observation.agentId } : {}),
      sessionId: observation.sessionId,
      runId: observation.runId,
      sourceGeneration: current.sourceGeneration,
      occurredAt: observation.occurredAt,
      origin: "LIVE",
    });
    if (!event) return;

    await input.outbox.enqueue(event);
    if (!current.registered && !(await registerCurrent())) {
      scheduleActivationRetry("ANOMALY");
      return;
    }
    const result = await input.publisher.drain();
    if (result.anomaly === "SEQUENCE_GAP") {
      await activateGeneration("SEQUENCE_GAP");
    } else if (result.pending > 0) {
      scheduleActivationRetry("ANOMALY");
    }
  };

  return {
    handleGatewayEvent(frame) {
      enqueue(() => processFrame(frame));
    },

    handleGatewayConnectionStateChange(state) {
      if (state.connected === connected) return;
      connected = state.connected;
      if (state.connected) {
        enqueue(activateGeneration);
      }
    },

    async flush() {
      await serial;
    },
  };
}
