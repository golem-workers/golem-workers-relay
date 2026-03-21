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
  highestSeqSeen: number;
  lastForwardedSeq: number;
  terminalSeen: boolean;
  terminalState: "final" | "error" | "aborted" | null;
  bufferedDeltas: BufferedDeltaSignal[];
  debounceTimer: NodeJS.Timeout | null;
  cleanupTimer: NodeJS.Timeout | null;
  sendChain: Promise<void>;
  nextReceivedOrder: number;
};

const CHAT_EVENT_BACKEND_DEBOUNCE_MS = 100;
const TERMINAL_RUN_STATE_RETENTION_MS = 60_000;

function createRunForwardState(runId: string, backendMessageId: string | null): RunForwardState {
  return {
    runId,
    backendMessageId,
    highestSeqSeen: -1,
    lastForwardedSeq: -1,
    terminalSeen: false,
    terminalState: null,
    bufferedDeltas: [],
    debounceTimer: null,
    cleanupTimer: null,
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
}): (evt: EventFrame) => Promise<void> {
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

  const deleteRunState = (runId: string): void => {
    const state = runStatesByRunId.get(runId);
    if (!state) {
      return;
    }
    clearDebounceTimer(state);
    clearCleanupTimer(state);
    runStatesByRunId.delete(runId);
  };

  const scheduleTerminalCleanup = (state: RunForwardState): void => {
    clearCleanupTimer(state);
    state.cleanupTimer = setTimeout(() => {
      deleteRunState(state.runId);
    }, TERMINAL_RUN_STATE_RETENTION_MS);
  };

  const flushBufferedSignals = async (runId: string): Promise<void> => {
    const state = runStatesByRunId.get(runId);
    if (!state) {
      return;
    }
    state.debounceTimer = null;
    if (state.terminalSeen) {
      state.bufferedDeltas = [];
      scheduleTerminalCleanup(state);
      return;
    }
    const deltas = [...state.bufferedDeltas].sort((left, right) => {
      if (left.seq !== right.seq) {
        return left.seq - right.seq;
      }
      return left.receivedOrder - right.receivedOrder;
    });
    state.bufferedDeltas = [];
    for (const delta of deltas) {
      if (state.terminalSeen) {
        break;
      }
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
            trace: {
              backendMessageId: state.backendMessageId,
              relayInstanceId,
              openclawRunId: delta.runId,
            },
          },
        });
      }
      if (delta.userFacingText) {
        await submitReplyChunk({
          relayInstanceId,
          backend,
          text: delta.userFacingText,
          runId: delta.runId,
          seq: delta.seq,
          relayMessageId: `relay_oc_reply_chunk_${randomUUID()}`,
          finishedAtMs: Date.now(),
          openclawMeta: {
            method: "gateway.event.chat.reply_chunk",
            runId: delta.runId,
            trace: {
              backendMessageId: state.backendMessageId,
              relayInstanceId,
              openclawRunId: delta.runId,
            },
          },
        });
      }
      state.lastForwardedSeq = Math.max(state.lastForwardedSeq, delta.seq);
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
    state.debounceTimer = setTimeout(() => {
      queueFlush(state.runId);
    }, CHAT_EVENT_BACKEND_DEBOUNCE_MS);
  };

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
    if (!runState && !runTrace) {
      if (chatEvent.state === "delta") {
        logger.warn(
          { relayInstanceId, runId: chatEvent.runId, sessionKey: chatEvent.sessionKey, seq: chatEvent.seq },
          "Skipping OpenClaw delta signal without correlated backend message"
        );
      }
      return;
    }
    if (!runState) {
      runState = createRunForwardState(chatEvent.runId, runTrace?.backendMessageId ?? null);
      runStatesByRunId.set(chatEvent.runId, runState);
    }
    if (!runState.backendMessageId && runTrace?.backendMessageId) {
      runState.backendMessageId = runTrace.backendMessageId;
    }
    runState.highestSeqSeen = Math.max(runState.highestSeqSeen, chatEvent.seq);

    if (isTerminalChatState(chatEvent.state)) {
      runState.terminalSeen = true;
      runState.terminalState = chatEvent.state;
      runState.bufferedDeltas = [];
      clearCleanupTimer(runState);
      scheduleDebouncedFlush(runState);
      return;
    }

    if (runState.terminalSeen) {
      scheduleTerminalCleanup(runState);
      return;
    }
    if (!runState.backendMessageId) {
      logger.warn(
        { relayInstanceId, runId: chatEvent.runId, sessionKey: chatEvent.sessionKey, seq: chatEvent.seq },
        "Skipping OpenClaw delta signal without correlated backend message"
      );
      return;
    }
    if (
      chatEvent.seq <= runState.lastForwardedSeq ||
      runState.bufferedDeltas.some((buffered) => buffered.seq === chatEvent.seq)
    ) {
      scheduleDebouncedFlush(runState);
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
    scheduleDebouncedFlush(runState);
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

async function submitReplyChunk(input: {
  relayInstanceId: string;
  backend: BackendClient;
  text: string;
  runId: string;
  seq: number;
  relayMessageId: string;
  finishedAtMs: number;
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
  try {
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId: input.relayMessageId,
        finishedAtMs: input.finishedAtMs,
        outcome: "reply_chunk",
        replyChunk: {
          text: input.text,
          runId: input.runId,
          seq: input.seq,
        },
        openclawMeta: {
          method: input.openclawMeta.method,
          ...(input.openclawMeta.runId ? { runId: input.openclawMeta.runId } : {}),
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
        outcome: "reply_chunk",
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to forward OpenClaw reply chunk to backend"
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
