import { randomUUID } from "node:crypto";
import { type BackendClient } from "../backend/backendClient.js";
import { logger } from "../logger.js";
import { chatEventSchema, type EventFrame } from "./protocol.js";

type ChatRunTrace = {
  backendMessageId: string;
};

type BufferedDeltaSignal = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta";
  userFacingText: string | null;
  frameSeq: number | null;
  stateVersion: unknown;
  receivedOrder: number;
};

type RunForwardState = {
  runId: string;
  backendMessageId: string | null;
  sessionKey: string | null;
  firstSeenAtMs: number;
  highestSeqSeen: number;
  lastForwardedSeq: number;
  lastRecoverySeq: number;
  primaryCompleted: boolean;
  lastDeliveredUserFacingText: string | null;
  terminalSeen: boolean;
  terminalState: "final" | "error" | "aborted" | null;
  terminalSeq: number | null;
  lastForwardedTerminalSeq: number;
  terminalHadMessage: boolean;
  terminalText: string | null;
  terminalTextPreview: string | null;
  bufferedDeltas: BufferedDeltaSignal[];
  debounceTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  deadLetterTimer: NodeJS.Timeout | null;
  sendChain: Promise<void>;
  nextReceivedOrder: number;
};

export type GatewayEventForwarder = ((evt: EventFrame) => Promise<void>) & {
  closeRun: (runId: string, reason: string) => void;
};

const CHAT_EVENT_BACKEND_DEBOUNCE_MS = 100;
const LATE_USER_FACING_QUIET_MS = 10_000;
const TERMINAL_RUN_STATE_RETENTION_MS = 10 * 60_000;
const UNCORRELATED_DELTA_RETRY_MS = 250;
const UNCORRELATED_DELTA_TTL_MS = 10_000;
const UNCORRELATED_DELTA_MAX_BUFFERED = 100;
const UNCORRELATED_DELTA_PREVIEW_CHARS = 500;

function createRunForwardState(runId: string, backendMessageId: string | null, sessionKey: string | null): RunForwardState {
  return {
    runId,
    backendMessageId,
    sessionKey,
    firstSeenAtMs: Date.now(),
    highestSeqSeen: -1,
    lastForwardedSeq: -1,
    lastRecoverySeq: -1,
    primaryCompleted: false,
    lastDeliveredUserFacingText: null,
    terminalSeen: false,
    terminalState: null,
    terminalSeq: null,
    lastForwardedTerminalSeq: -1,
    terminalHadMessage: false,
    terminalText: null,
    terminalTextPreview: null,
    bufferedDeltas: [],
    debounceTimer: null,
    cleanupTimer: null,
    deadLetterTimer: null,
    sendChain: Promise.resolve(),
    nextReceivedOrder: 0,
  };
}

function isTerminalChatState(state: string): state is "final" | "error" | "aborted" {
  return state === "final" || state === "error" || state === "aborted";
}

export function createGatewayEventForwarder(input: {
  relayInstanceId: string;
  backend: BackendClient;
  forwardFinalOnly: boolean;
  getChatRunTrace: (runId: string) => ChatRunTrace | null;
}): GatewayEventForwarder {
  const { relayInstanceId, backend, forwardFinalOnly, getChatRunTrace } = input;
  const runStatesByRunId = new Map<string, RunForwardState>();

  const clearDebounceTimer = (state: RunForwardState): void => {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  };

  const clearCleanupTimer = (state: RunForwardState): void => {
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = null;
    }
  };

  const clearDeadLetterTimer = (state: RunForwardState): void => {
    if (state.deadLetterTimer) {
      clearTimeout(state.deadLetterTimer);
      state.deadLetterTimer = null;
    }
  };

  const deleteRunState = (runId: string): void => {
    const state = runStatesByRunId.get(runId);
    if (!state) {
      return;
    }
    clearDebounceTimer(state);
    clearCleanupTimer(state);
    clearDeadLetterTimer(state);
    runStatesByRunId.delete(runId);
  };

  const closeRun = (runId: string, reason: string): void => {
    const state = runStatesByRunId.get(runId);
    if (state) {
      state.primaryCompleted = true;
      if (
        shouldTreatTerminalTextAsPrimaryDelivered(reason) &&
        state.terminalText &&
        !state.lastDeliveredUserFacingText
      ) {
        state.lastDeliveredUserFacingText = state.terminalText;
      }
      clearDebounceTimer(state);
      scheduleTerminalCleanup(state);
    }
    logger.info({ relayInstanceId, runId, reason }, "Marked OpenClaw chat run as primary-completed");
  };

  const scheduleTerminalCleanup = (state: RunForwardState): void => {
    clearCleanupTimer(state);
    state.cleanupTimer = setTimeout(() => {
      deleteRunState(state.runId);
    }, TERMINAL_RUN_STATE_RETENTION_MS);
    state.cleanupTimer.unref?.();
  };

  const computePendingUserFacingText = (state: RunForwardState, text: string | null): string | null => {
    const normalizedText = typeof text === "string" ? text.trim() : "";
    if (!normalizedText) {
      return null;
    }
    const delivered = state.lastDeliveredUserFacingText?.trim() ?? "";
    if (!delivered) {
      return normalizedText;
    }
    if (normalizedText === delivered) {
      return null;
    }
    if (normalizedText.startsWith(delivered)) {
      const suffix = normalizedText.slice(delivered.length).trim();
      return suffix || null;
    }
    return normalizedText;
  };

  const attachTraceIfAvailable = (state: RunForwardState): boolean => {
    if (state.backendMessageId) return true;
    const trace = getChatRunTrace(state.runId);
    if (!trace?.backendMessageId) return false;
    state.backendMessageId = trace.backendMessageId;
    clearDeadLetterTimer(state);
    logger.info(
      {
        relayInstanceId,
        runId: state.runId,
        backendMessageId: trace.backendMessageId,
        bufferedCount: state.bufferedDeltas.length,
      },
      "Recovered OpenClaw chat event correlation"
    );
    return true;
  };

  const buildDeadLetterPayload = (state: RunForwardState, reason: string): unknown => {
    const deltas = [...state.bufferedDeltas].sort((left, right) => {
      if (left.seq !== right.seq) return left.seq - right.seq;
      return left.receivedOrder - right.receivedOrder;
    });
    const latestDeltaText =
      [...deltas]
        .reverse()
        .map((delta) => delta.userFacingText)
        .find((text): text is string => Boolean(text?.trim())) ?? null;
    const userFacingText = state.terminalText ?? latestDeltaText;
    return {
      reason,
      runId: state.runId,
      sessionKey: state.sessionKey,
      terminalSeen: state.terminalSeen,
      terminalState: state.terminalState,
      terminalSeq: state.terminalSeq,
      terminalHadMessage: state.terminalHadMessage,
      terminalText: state.terminalText,
      terminalTextPreview: state.terminalTextPreview,
      userFacingText,
      bufferedCount: deltas.length,
      firstSeq: deltas.at(0)?.seq ?? null,
      lastSeq: deltas.at(-1)?.seq ?? null,
      highestSeqSeen: state.highestSeqSeen,
      ageMs: Date.now() - state.firstSeenAtMs,
      textPreview: (latestDeltaText ?? "").slice(0, UNCORRELATED_DELTA_PREVIEW_CHARS),
    };
  };

  const deadLetterUncorrelatedState = (state: RunForwardState, reason: string): void => {
    clearDebounceTimer(state);
    clearDeadLetterTimer(state);
    const payload = buildDeadLetterPayload(state, reason);
    logger.error(
      { relayInstanceId, runId: state.runId, reason, payload },
      "OpenClaw chat events could not be correlated before dead-letter"
    );
    state.sendChain = state.sendChain
      .then(() =>
        submitTechnicalEvent({
          relayInstanceId,
          backend,
          technicalEvent: "chat.uncorrelated_delta_dead_letter",
          technicalPayload: payload,
          seq: null,
          stateVersion: null,
          openclawMeta: {
            method: "gateway.event.chat.uncorrelated_delta_dead_letter",
            runId: state.runId,
          ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
            trace: {
              relayInstanceId,
              openclawRunId: state.runId,
            },
          },
        })
      )
      .finally(() => {
        deleteRunState(state.runId);
      });
  };

  const scheduleUncorrelatedRetry = (state: RunForwardState): void => {
    clearDebounceTimer(state);
    if (Date.now() - state.firstSeenAtMs >= UNCORRELATED_DELTA_TTL_MS) {
      deadLetterUncorrelatedState(state, "ttl_expired");
      return;
    }
    state.debounceTimer = setTimeout(() => {
      if (attachTraceIfAvailable(state)) {
        queueFlush(state.runId);
        return;
      }
      scheduleUncorrelatedRetry(state);
    }, UNCORRELATED_DELTA_RETRY_MS);
    state.debounceTimer.unref?.();
    if (!state.deadLetterTimer) {
      state.deadLetterTimer = setTimeout(() => {
        if (!attachTraceIfAvailable(state)) {
          deadLetterUncorrelatedState(state, "ttl_expired");
        } else {
          queueFlush(state.runId);
        }
      }, UNCORRELATED_DELTA_TTL_MS);
      state.deadLetterTimer.unref?.();
    }
  };

  const flushBufferedSignals = async (runId: string): Promise<void> => {
    const state = runStatesByRunId.get(runId);
    if (!state) {
      return;
    }
    state.debounceTimer = null;
    attachTraceIfAvailable(state);
    if (!state.backendMessageId) {
      scheduleUncorrelatedRetry(state);
      return;
    }
    const deltas = [...state.bufferedDeltas].sort((left, right) => {
      if (left.seq !== right.seq) {
        return left.seq - right.seq;
      }
      return left.receivedOrder - right.receivedOrder;
    });
    state.bufferedDeltas = [];
    let latestUserFacingDelta: BufferedDeltaSignal | null = null;
    for (const delta of deltas) {
      if (!state.backendMessageId || delta.seq <= state.lastForwardedSeq) {
        continue;
      }
      if (forwardFinalOnly) {
        await submitTechnicalEvent({
          relayInstanceId,
          backend,
          technicalEvent: "chat.delta_signal",
          technicalPayload: {
            runId: delta.runId,
            sessionKey: delta.sessionKey,
            seq: delta.seq,
            state: delta.state,
          },
          seq: delta.frameSeq,
          stateVersion: delta.stateVersion,
          openclawMeta: {
            method: "gateway.event.chat.delta_signal",
            runId: delta.runId,
            sessionKey: delta.sessionKey,
            trace: {
              backendMessageId: state.backendMessageId,
              relayInstanceId,
              openclawRunId: delta.runId,
            },
          },
        });
      }
      if (delta.userFacingText) {
        latestUserFacingDelta = delta;
      }
      state.lastForwardedSeq = Math.max(state.lastForwardedSeq, delta.seq);
    }
    if (state.primaryCompleted && latestUserFacingDelta?.userFacingText) {
      const pendingText = computePendingUserFacingText(state, latestUserFacingDelta.userFacingText);
      if (pendingText && latestUserFacingDelta.seq > state.lastRecoverySeq) {
        await submitUserFacingRecovery({
          relayInstanceId,
          backend,
          text: pendingText,
          runId: latestUserFacingDelta.runId,
          sessionKey: latestUserFacingDelta.sessionKey,
          seq: latestUserFacingDelta.seq,
          state: "delta",
          reason: "delta_quiet_timeout",
          relayMessageId: `relay_oc_recovery_${randomUUID()}`,
          finishedAtMs: Date.now(),
          correlationStrength: "trace",
          openclawMeta: {
            method: "gateway.event.chat.user_facing_recovery",
            runId: latestUserFacingDelta.runId,
            sessionKey: latestUserFacingDelta.sessionKey,
            trace: {
              backendMessageId: state.backendMessageId,
              relayInstanceId,
              openclawRunId: latestUserFacingDelta.runId,
            },
          },
        });
        state.lastDeliveredUserFacingText = latestUserFacingDelta.userFacingText;
        state.lastRecoverySeq = latestUserFacingDelta.seq;
      }
    }
    if (
      state.primaryCompleted &&
      state.terminalSeen &&
      state.terminalSeq !== null &&
      state.terminalSeq > state.lastForwardedTerminalSeq &&
      state.terminalSeq > state.lastRecoverySeq &&
      state.terminalText
    ) {
      const pendingText = computePendingUserFacingText(state, state.terminalText);
      if (pendingText) {
        await submitUserFacingRecovery({
          relayInstanceId,
          backend,
          text: pendingText,
          runId: state.runId,
          sessionKey: state.sessionKey,
          seq: state.terminalSeq,
          state: state.terminalState ?? "final",
          reason: `terminal_${state.terminalState ?? "final"}`,
          relayMessageId: `relay_oc_recovery_${randomUUID()}`,
          finishedAtMs: Date.now(),
          correlationStrength: "trace",
          openclawMeta: {
            method: "gateway.event.chat.user_facing_recovery",
            runId: state.runId,
            ...(state.sessionKey ? { sessionKey: state.sessionKey } : {}),
            trace: {
              backendMessageId: state.backendMessageId,
              relayInstanceId,
              openclawRunId: state.runId,
            },
          },
        });
        state.lastDeliveredUserFacingText = state.terminalText;
      }
      state.lastForwardedTerminalSeq = Math.max(state.lastForwardedTerminalSeq, state.terminalSeq);
    }
    if (state.terminalSeen && !state.debounceTimer) {
      scheduleTerminalCleanup(state);
    }
  };

  const queueFlush = (runId: string): void => {
    const state = runStatesByRunId.get(runId);
    if (!state) {
      return;
    }
    state.sendChain = state.sendChain
      .then(() => flushBufferedSignals(runId))
      .catch((error) => {
        logger.warn(
          { relayInstanceId, runId, error: error instanceof Error ? error.message : String(error) },
          "Failed to flush buffered OpenClaw chat events"
        );
      });
  };

  const scheduleDebouncedFlush = (state: RunForwardState): void => {
    clearDebounceTimer(state);
    const delayMs = state.primaryCompleted ? LATE_USER_FACING_QUIET_MS : CHAT_EVENT_BACKEND_DEBOUNCE_MS;
    state.debounceTimer = setTimeout(() => {
      queueFlush(state.runId);
    }, delayMs);
    state.debounceTimer.unref?.();
  };

  const forward = (async (evt: EventFrame): Promise<void> => {
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
      if (evt.event !== "chat") {
        return;
      }
    } else if (evt.event !== "chat") {
      return;
    }
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvent = parsed.data;
    const runTrace = getChatRunTrace(chatEvent.runId);
    let runState = runStatesByRunId.get(chatEvent.runId) ?? null;
    if (!runState) {
      runState = createRunForwardState(chatEvent.runId, runTrace?.backendMessageId ?? null, chatEvent.sessionKey);
      runStatesByRunId.set(chatEvent.runId, runState);
    } else if (!runState.sessionKey) {
      runState.sessionKey = chatEvent.sessionKey;
    }
    if (!runState.backendMessageId && runTrace?.backendMessageId) {
      runState.backendMessageId = runTrace.backendMessageId;
      clearDeadLetterTimer(runState);
    }
    runState.highestSeqSeen = Math.max(runState.highestSeqSeen, chatEvent.seq);

    if (isTerminalChatState(chatEvent.state)) {
      const terminalText = extractPlainAssistantText(chatEvent.message);
      const terminalTextPreview = terminalText?.slice(0, UNCORRELATED_DELTA_PREVIEW_CHARS) ?? null;
      runState.terminalSeen = true;
      runState.terminalState = chatEvent.state;
      runState.terminalSeq = chatEvent.seq;
      runState.terminalHadMessage = terminalTextPreview !== null;
      runState.terminalText = terminalText;
      runState.terminalTextPreview = terminalTextPreview;
      clearCleanupTimer(runState);
      if (runState.backendMessageId) {
        if (runState.primaryCompleted && terminalText) {
          queueFlush(runState.runId);
          return;
        }
        scheduleDebouncedFlush(runState);
      } else {
        scheduleUncorrelatedRetry(runState);
      }
      return;
    }

    if (
      chatEvent.seq <= runState.lastForwardedSeq ||
      runState.bufferedDeltas.some((buffered) => buffered.seq === chatEvent.seq)
    ) {
      if (runState.backendMessageId) {
        scheduleDebouncedFlush(runState);
      } else {
        scheduleUncorrelatedRetry(runState);
      }
      return;
    }
    runState.bufferedDeltas.push({
      runId: chatEvent.runId,
      sessionKey: chatEvent.sessionKey,
      seq: chatEvent.seq,
      state: "delta",
      userFacingText: extractPlainAssistantText(chatEvent.message),
      frameSeq: evt.seq ?? chatEvent.seq,
      stateVersion: evt.stateVersion ?? null,
      receivedOrder: runState.nextReceivedOrder++,
    });
    if (runState.bufferedDeltas.length > UNCORRELATED_DELTA_MAX_BUFFERED && !runState.backendMessageId) {
      deadLetterUncorrelatedState(runState, "buffer_limit_exceeded");
      return;
    }
    if (runState.backendMessageId) {
      scheduleDebouncedFlush(runState);
    } else {
      logger.warn(
        {
          relayInstanceId,
          runId: chatEvent.runId,
          sessionKey: chatEvent.sessionKey,
          seq: chatEvent.seq,
          bufferedCount: runState.bufferedDeltas.length,
        },
        "Buffering OpenClaw delta signal until backend message correlation is available"
      );
      scheduleUncorrelatedRetry(runState);
    }
  }) as GatewayEventForwarder;
  forward.closeRun = closeRun;
  return forward;
}

function shouldTreatTerminalTextAsPrimaryDelivered(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (
    normalized.includes("aborted") ||
    normalized.includes("error") ||
    normalized.includes("timeout") ||
    normalized.includes("failed") ||
    normalized.includes("no_message") ||
    normalized.includes("no_reply")
  ) {
    return false;
  }
  return true;
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
    sessionKey?: string;
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
          ...(input.openclawMeta.sessionKey ? { sessionKey: input.openclawMeta.sessionKey } : {}),
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

async function submitUserFacingRecovery(input: {
  relayInstanceId: string;
  backend: BackendClient;
  text: string;
  runId: string;
  sessionKey: string | null;
  seq: number;
  state: "delta" | "final" | "error" | "aborted";
  reason: string;
  relayMessageId: string;
  finishedAtMs: number;
  correlationStrength: "trace" | "session" | "weak";
  openclawMeta: {
    method: string;
    runId?: string;
    sessionKey?: string;
    trace: {
      backendMessageId?: string;
      relayInstanceId: string;
      openclawRunId?: string;
    };
  };
}): Promise<void> {
  try {
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId: input.relayMessageId,
        finishedAtMs: input.finishedAtMs,
        outcome: "technical",
        technical: {
          source: "openclaw_gateway",
          event: "chat.user_facing_recovery",
          payload: {
            runId: input.runId,
            sessionKey: input.sessionKey,
            seq: input.seq,
            state: input.state,
            reason: input.reason,
            userFacingText: input.text,
            correlationStrength: input.correlationStrength,
          },
        },
        openclawMeta: {
          method: input.openclawMeta.method,
          ...(input.openclawMeta.runId ? { runId: input.openclawMeta.runId } : {}),
          ...(input.openclawMeta.sessionKey ? { sessionKey: input.openclawMeta.sessionKey } : {}),
          trace: {
            ...(input.openclawMeta.trace.backendMessageId
              ? { backendMessageId: input.openclawMeta.trace.backendMessageId }
              : {}),
            relayMessageId: input.relayMessageId,
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
        relayMessageId: input.relayMessageId,
        relayInstanceId: input.relayInstanceId,
        outcome: "technical",
        technicalEvent: "chat.user_facing_recovery",
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to forward OpenClaw user-facing recovery text to backend"
    );
  }
}

function extractPlainAssistantText(message: unknown): string | null {
  if (typeof message === "string") {
    return message.trim() || null;
  }
  if (!isPlainObject(message)) {
    return null;
  }
  const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "assistant";
  if (role && role !== "assistant") {
    return null;
  }
  if (typeof message.content === "string") {
    return message.content.trim() || null;
  }
  if (typeof message.text === "string") {
    return message.text.trim() || null;
  }
  if (!Array.isArray(message.content)) {
    return null;
  }
  const text = message.content
    .map((part) => readTextContentPart(part))
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .trim();
  return text || null;
}

function readTextContentPart(part: unknown): string | null {
  if (typeof part === "string") {
    return part.trim() || null;
  }
  if (!isPlainObject(part)) {
    return null;
  }
  const type = typeof part.type === "string" ? part.type : "";
  if (type !== "text" && type !== "output_text" && type !== "input_text") {
    return null;
  }
  if (typeof part.text === "string") {
    return part.text.trim() || null;
  }
  if (isPlainObject(part.text) && typeof part.text.value === "string") {
    return part.text.value.trim() || null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { constructor?: unknown }).constructor === Object
  );
}
