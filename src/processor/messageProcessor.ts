import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type BackendClient } from "../backend/backendClient.js";
import { type InboundPushMessage, type RelayInboundMessageRequest } from "../backend/types.js";
import { logger } from "../logger.js";
import { type ChatRunner } from "../openclaw/chatRunner.js";
import { type GatewayClient } from "../openclaw/gatewayClient.js";
import { makeTextPreview } from "../common/utils/text.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

type MessageProcessorInput = {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    systemTaskTimeoutMs?: number;
    chatBatchDebounceMs: number;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  readDiskUsage?: (path: string) => Promise<DiskUsageSnapshot>;
  taskControl?: RelayTaskControl;
};

type DiskUsageSnapshot = {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type DeliverySystem = "relay_channel_v2";
type RelayProcessingErrorCode =
  | "RELAY_INTERNAL_ERROR"
  | "RELAY_DIRECT_TRANSPORT_DELIVERY_FAILED"
  | "RELAY_TASK_TIMEOUT"
  | "RELAY_SYSTEM_TASK_TIMEOUT"
  | "RELAY_TASK_PREEMPTED";

class RelayProcessingError extends Error {
  readonly code: RelayProcessingErrorCode;

  constructor(input: { code: RelayProcessingErrorCode; message: string; cause?: unknown }) {
    super(input.message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "RelayProcessingError";
    this.code = input.code;
  }
}

type RelayTaskKind = "user_chat" | "system_reminder" | "other";

export type ActiveRelayTaskSnapshot = {
  messageId: string;
  sessionKey: string | null;
  taskKind: RelayTaskKind;
  startedAtMs: number;
};

export type RelayTaskControl = {
  register(task: ActiveRelayTaskSnapshot & { abort: (reason: string) => void }): () => void;
  abortActive(predicate: (task: ActiveRelayTaskSnapshot) => boolean, reason: string): boolean;
  getActiveTask(): ActiveRelayTaskSnapshot | null;
  getActiveTasks(): ActiveRelayTaskSnapshot[];
};

export function createRelayTaskControl(): RelayTaskControl {
  const activeByMessageId = new Map<
    string,
    ActiveRelayTaskSnapshot & {
      abort: (reason: string) => void;
    }
  >();
  return {
    register(task) {
      activeByMessageId.set(task.messageId, task);
      return () => {
        if (activeByMessageId.get(task.messageId) === task) {
          activeByMessageId.delete(task.messageId);
        }
      };
    },
    abortActive(predicate, reason) {
      let aborted = false;
      for (const active of activeByMessageId.values()) {
        if (!predicate(active)) continue;
        active.abort(reason);
        aborted = true;
      }
      return aborted;
    },
    getActiveTask() {
      const active = activeByMessageId.values().next().value;
      if (!active) return null;
      const { messageId, sessionKey, taskKind, startedAtMs } = active;
      return { messageId, sessionKey, taskKind, startedAtMs };
    },
    getActiveTasks() {
      return Array.from(activeByMessageId.values(), ({ messageId, sessionKey, taskKind, startedAtMs }) => ({
        messageId,
        sessionKey,
        taskKind,
        startedAtMs,
      }));
    },
  };
}

export function createMessageProcessor(input: MessageProcessorInput): (msg: InboundPushMessage) => Promise<void> {
  const { cfg, gateway, runner, backend } = input;
  const readDiskUsage = input.readDiskUsage ?? readDiskUsageSnapshot;
  const taskControl = input.taskControl ?? createRelayTaskControl();
  const chatBatchesBySession = new Map<string, ChatBatchState>();
  const chatBatchDebounceMs = Math.max(0, Math.trunc(cfg.chatBatchDebounceMs));

  return async (msg: InboundPushMessage): Promise<void> => {
    if (msg.input.kind !== "chat" || chatBatchDebounceMs === 0) {
      await processSingleMessage({ cfg, gateway, runner, backend, msg, readDiskUsage, taskControl });
      return;
    }
    await enqueueChatBatch({
      sessionKey: msg.input.sessionKey,
      msg,
      debounceMs: chatBatchDebounceMs,
      chatBatchesBySession,
      flush: async (items) => {
        await flushChatBatch({ cfg, gateway, runner, backend, items, readDiskUsage, taskControl });
      },
    });
  };
}

type Deferred = {
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
};

type ChatBatchItem = {
  msg: InboundPushMessage;
  deferred: Deferred;
};

type ChatBatchState = {
  timer: NodeJS.Timeout | null;
  items: ChatBatchItem[];
};

function buildInboundMessageLogMeta(
  msg: InboundPushMessage,
  input: { textMaxLen: number }
): Record<string, unknown> {
  return {
    kind: msg.input.kind,
    sessionKey: msg.input.kind === "chat" ? msg.input.sessionKey : null,
    textLen: msg.input.kind === "chat" ? msg.input.messageText.length : null,
    textPreview:
      msg.input.kind === "chat" ? makeTextPreview(msg.input.messageText, input.textMaxLen) : null,
    mediaCount: msg.input.kind === "chat" ? (msg.input.media?.length ?? 0) : null,
  };
}

function readContextKind(context: unknown): string | null {
  if (!isPlainObject(context)) return null;
  return readNonEmptyString(context.kind) ?? null;
}

function classifyRelayTask(msg: InboundPushMessage): RelayTaskKind {
  if (msg.input.kind !== "chat") {
    return "other";
  }
  const contextKind = readContextKind(msg.input.context);
  if (contextKind === "relay_stale_timeout_reminder" || contextKind === "relay_status_nudge") {
    return "system_reminder";
  }
  return "user_chat";
}

function getEffectiveTaskTimeoutMs(input: {
  taskKind: RelayTaskKind;
  taskTimeoutMs: number;
  systemTaskTimeoutMs?: number;
}): number {
  if (input.taskKind === "system_reminder") {
    return Math.max(1, Math.trunc(input.systemTaskTimeoutMs ?? Math.min(input.taskTimeoutMs, 120_000)));
  }
  return Math.max(1, Math.trunc(input.taskTimeoutMs));
}

class RelayTaskAbortError extends RelayProcessingError {
  readonly reason: string;

  constructor(reason: string) {
    super({
      code: "RELAY_TASK_PREEMPTED",
      message: `Relay task was preempted: ${reason}`,
    });
    this.reason = reason;
  }
}

function createAbortPromise(): {
  promise: Promise<never>;
  abort: (reason: string) => void;
} {
  let rejectAbort!: (error: RelayTaskAbortError) => void;
  const promise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  return {
    promise,
    abort: (reason: string) => rejectAbort(new RelayTaskAbortError(reason)),
  };
}

function createSlidingTaskTimeout(input: {
  timeoutMs: number;
  buildError: () => RelayProcessingError;
}): {
  promise: Promise<never>;
  touch: () => void;
  clear: () => void;
} {
  let timeout: NodeJS.Timeout | null = null;
  let cleared = false;
  let rejectTimeout!: (error: RelayProcessingError) => void;
  const arm = (): void => {
    if (cleared) return;
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timeout = null;
      cleared = true;
      rejectTimeout(input.buildError());
    }, input.timeoutMs);
    timeout.unref?.();
  };
  const promise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  arm();
  return {
    promise,
    touch: arm,
    clear: () => {
      cleared = true;
      if (!timeout) return;
      clearTimeout(timeout);
      timeout = null;
    },
  };
}

async function enqueueChatBatch(input: {
  sessionKey: string;
  msg: InboundPushMessage;
  debounceMs: number;
  chatBatchesBySession: Map<string, ChatBatchState>;
  flush: (items: ChatBatchItem[]) => Promise<void>;
}): Promise<void> {
  const deferred = createDeferred();
  const state =
    input.chatBatchesBySession.get(input.sessionKey) ??
    (() => {
      const created: ChatBatchState = { timer: null, items: [] };
      input.chatBatchesBySession.set(input.sessionKey, created);
      return created;
    })();
  state.items.push({ msg: input.msg, deferred });
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = setTimeout(() => {
    const current = input.chatBatchesBySession.get(input.sessionKey);
    if (!current) return;
    input.chatBatchesBySession.delete(input.sessionKey);
    const items = current.items;
    if (items.length === 0) return;
    void input.flush(items).catch((error) => {
      for (const item of items) {
        item.deferred.reject(error);
      }
    });
  }, input.debounceMs);
  return deferred.promise;
}

async function flushChatBatch(input: {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    systemTaskTimeoutMs?: number;
    chatBatchDebounceMs: number;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  items: ChatBatchItem[];
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
  taskControl: RelayTaskControl;
}): Promise<void> {
  if (input.items.length === 0) return;
  if (input.items.length === 1) {
    const only = input.items[0];
    try {
      await processSingleMessage({
        cfg: input.cfg,
        gateway: input.gateway,
        runner: input.runner,
        backend: input.backend,
        msg: only.msg,
        readDiskUsage: input.readDiskUsage,
        taskControl: input.taskControl,
      });
      only.deferred.resolve();
    } catch (error) {
      only.deferred.reject(error);
    }
    return;
  }

  const firstItems = input.items.slice(0, -1);
  const target = input.items[input.items.length - 1];
  const mergedMessage = buildMergedChatMessage(input.items.map((item) => item.msg), target.msg.messageId);

  for (const item of firstItems) {
    try {
      await submitBatchedNoReply({
        cfg: input.cfg,
        backend: input.backend,
        sourceMessage: item.msg,
        targetMessageId: target.msg.messageId,
        batchedCount: input.items.length,
      });
      item.deferred.resolve();
    } catch (error) {
      item.deferred.reject(error);
    }
  }

  try {
    await processSingleMessage({
      cfg: input.cfg,
      gateway: input.gateway,
      runner: input.runner,
      backend: input.backend,
      msg: mergedMessage,
      readDiskUsage: input.readDiskUsage,
      taskControl: input.taskControl,
    });
    target.deferred.resolve();
  } catch (error) {
    target.deferred.reject(error);
  }
}

function buildMergedChatMessage(
  items: InboundPushMessage[],
  targetMessageId: string
): InboundPushMessage {
  const tail = items[items.length - 1];
  const chatItems = items.filter(
    (item): item is InboundPushMessage & { input: Extract<InboundPushMessage["input"], { kind: "chat" }> } =>
      item.input.kind === "chat"
  );
  const messageText = items
    .map((item) => (item.input.kind === "chat" ? item.input.messageText.trim() : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
  const media = chatItems.flatMap((item) => (Array.isArray(item.input.media) ? item.input.media : []));
  return {
    ...tail,
    messageId: targetMessageId,
    input: {
      ...(tail.input.kind === "chat" ? tail.input : chatItems[chatItems.length - 1].input),
      messageText,
      ...(media.length > 0 ? { media } : {}),
    },
  };
}

async function submitBatchedNoReply(input: {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    systemTaskTimeoutMs?: number;
    chatBatchDebounceMs: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  backend: BackendClient;
  sourceMessage: InboundPushMessage;
  targetMessageId: string;
  batchedCount: number;
}): Promise<void> {
  const relayMessageId = `relay_${randomUUID()}`;
  const finishedAtMs = Date.now();
  await input.backend.submitInboundMessage({
    body: {
      relayInstanceId: input.cfg.relayInstanceId,
      relayMessageId,
      finishedAtMs,
      outcome: "no_reply",
      noReply: {
        reason: "batched",
        batchedIntoMessageId: input.targetMessageId,
        batchedCount: input.batchedCount,
      },
      openclawMeta: buildOpenclawMetaWithTrace(
        {
          method: "chat.batch",
          batch: {
            strategy: "debounce",
            debounceMs: input.cfg.chatBatchDebounceMs,
          },
        },
        {
          backendMessageId: input.sourceMessage.messageId,
          relayMessageId,
          relayInstanceId: input.cfg.relayInstanceId,
        },
        input.sourceMessage.input.kind === "chat" ? { sessionKey: input.sourceMessage.input.sessionKey } : undefined
      ),
    },
  });
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

async function processSingleMessage(input: {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    systemTaskTimeoutMs?: number;
    chatBatchDebounceMs: number;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  msg: InboundPushMessage;
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
  taskControl: RelayTaskControl;
}): Promise<void> {
  const { cfg, gateway, runner, backend, msg } = input;
  const startedAt = Date.now();
  const relayMessageId = `relay_${randomUUID()}`;
  const messageMeta = buildInboundMessageLogMeta(msg, { textMaxLen: cfg.devLogTextMaxLen });
  const taskKind = classifyRelayTask(msg);
  const effectiveTaskTimeoutMs = getEffectiveTaskTimeoutMs({
    taskKind,
    taskTimeoutMs: cfg.taskTimeoutMs,
    systemTaskTimeoutMs: cfg.systemTaskTimeoutMs,
  });
  const watchdogDelayMs = Math.min(effectiveTaskTimeoutMs, 30_000);
  const watchdog = setTimeout(() => {
    logger.warn(
      {
        event: "message_flow",
        direction: "relay_internal",
        stage: "processing_stalled",
        backendMessageId: msg.messageId,
        relayMessageId,
        waitedMs: Date.now() - startedAt,
        taskKind,
        taskTimeoutMs: effectiveTaskTimeoutMs,
        ...messageMeta,
      },
      "Relay task is still running"
    );
  }, watchdogDelayMs);
  watchdog.unref?.();
  try {
    logger.info(
      {
        event: "message_flow",
        direction: "backend_to_relay",
        stage: "processing_started",
        backendMessageId: msg.messageId,
        relayMessageId,
        ...messageMeta,
      },
      "Relay task started"
    );
    if (cfg.devLogEnabled) {
      logger.info(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "received",
          backendMessageId: msg.messageId,
          relayMessageId,
          ...messageMeta,
        },
        "Message flow transition"
      );
    }

    await maybeSubmitLowDiskSpaceAlert({
      cfg,
      backend,
      correlationMessageId: msg.messageId,
      parentRelayMessageId: relayMessageId,
      readDiskUsage: input.readDiskUsage,
    });

    if (msg.input.kind === "handshake") {
      await withTimeout(gateway.start(), cfg.taskTimeoutMs, "gateway.start");
      const hello = gateway.getHello();
      if (!hello) {
        throw new Error("Gateway is not ready (missing hello-ok)");
      }
      const finishedAtMs = Date.now();
      await backend.submitInboundMessage({
        body: {
          relayInstanceId: cfg.relayInstanceId,
          relayMessageId,
          finishedAtMs,
          outcome: "reply",
          reply: {
            nonce: msg.input.nonce,
            helloType: hello.type,
            protocol: hello.protocol,
            policy: hello.policy,
            features: hello.features
              ? { methodsCount: hello.features.methods.length, eventsCount: hello.features.events.length }
              : null,
            auth: hello.auth ? { role: hello.auth.role, scopes: hello.auth.scopes } : null,
          },
          openclawMeta: buildOpenclawMetaWithTrace(
            { method: "connect" },
            { backendMessageId: msg.messageId, relayMessageId, relayInstanceId: cfg.relayInstanceId }
          ),
        },
      });
    } else if (msg.input.kind === "session_new") {
      const reset = await runner.startNewSessionForAll();
      const finishedAtMs = Date.now();
      await backend.submitInboundMessage({
        body: {
          relayInstanceId: cfg.relayInstanceId,
          relayMessageId,
          finishedAtMs,
          outcome: "reply",
          reply: reset,
          openclawMeta: buildOpenclawMetaWithTrace(
            { method: "session_new" },
            { backendMessageId: msg.messageId, relayMessageId, relayInstanceId: cfg.relayInstanceId }
          ),
        },
      });
    } else if (msg.input.kind === "transport_event") {
      logger.info(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "accepted",
          backendMessageId: msg.messageId,
          relayMessageId,
          kind: msg.input.kind,
          eventType: msg.input.event.eventType,
        },
        "Transport event was accepted by relay ingress"
      );
    } else if (msg.input.kind === "agent_control") {
      throw new Error("agent_control tasks must be handled synchronously by relay ingress");
    } else {
      const deliverySystem = readDeliverySystemFromTaskContext(msg.input.context);
      const abortController = createAbortPromise();
      const unregisterActiveTask = input.taskControl.register({
        messageId: msg.messageId,
        sessionKey: msg.input.sessionKey,
        taskKind,
        startedAtMs: startedAt,
        abort: abortController.abort,
      });
      logger.info(
        {
          event: "message_flow",
          direction: "relay_to_openclaw",
          stage: "chat_runner_start",
          backendMessageId: msg.messageId,
          relayMessageId,
          sessionKey: msg.input.sessionKey,
          deliverySystem,
          textLen: msg.input.messageText.length,
          mediaCount: msg.input.media?.length ?? 0,
        },
        "Dispatching chat task to OpenClaw"
      );
      let timedOut = false;
      const taskTimeout = createSlidingTaskTimeout({
        timeoutMs: effectiveTaskTimeoutMs,
        buildError: () => {
          timedOut = true;
          return new RelayProcessingError({
            code: taskKind === "system_reminder" ? "RELAY_SYSTEM_TASK_TIMEOUT" : "RELAY_TASK_TIMEOUT",
            message:
              taskKind === "system_reminder"
                ? "Relay system task timed out and was released to avoid blocking user messages"
                : "Relay task timed out and was released to avoid blocking the message queue",
          });
        },
      });
      const runnerPromise = runner.runChatTask({
        taskId: msg.messageId,
        sessionKey: msg.input.sessionKey,
        messageText: msg.input.messageText,
        media: msg.input.media,
        context: msg.input.context,
        deliverySystem,
        timeoutMs: effectiveTaskTimeoutMs,
        onActivity: taskTimeout.touch,
      });
      try {
        const { result, openclawMeta } = await Promise.race([
          runnerPromise,
          abortController.promise,
          taskTimeout.promise,
        ]);
        taskTimeout.clear();
        unregisterActiveTask();
        const openclawRunId =
          result.outcome === "reply"
            ? result.reply.runId
            : result.outcome === "no_reply"
              ? (result.noReply?.runId ?? null)
              : result.error.runId;
        logger.info(
          {
            event: "message_flow",
            direction: "relay_to_openclaw",
            stage: "chat_runner_finished",
            backendMessageId: msg.messageId,
            relayMessageId,
            outcome: result.outcome,
            deliverySystem,
            openclawRunId,
            durationMs: Date.now() - startedAt,
          },
          "OpenClaw chat task finished"
        );
        const finishedAtMs = Date.now();
        if (result.outcome === "reply") {
          const replyPayload = await buildReplyPayload(result.reply);
          const directTransportMeta = maybeDeliverRelayChannelReplyDirectly({
            backend,
            context: msg.input.context,
            sessionKey: msg.input.sessionKey,
            reply: replyPayload,
            backendMessageId: msg.messageId,
            relayMessageId,
          });
          await backend.submitInboundMessage({
            body: {
              relayInstanceId: cfg.relayInstanceId,
              relayMessageId,
              finishedAtMs,
              outcome: "reply",
              reply: replyPayload,
              openclawMeta: buildOpenclawMetaWithTrace(
                normalizeOpenclawMeta(openclawMeta),
                {
                  backendMessageId: msg.messageId,
                  relayMessageId,
                  relayInstanceId: cfg.relayInstanceId,
                  openclawRunId: result.reply.runId,
                },
                { deliverySystem, sessionKey: msg.input.sessionKey, ...directTransportMeta }
              ),
            },
          });
        } else if (result.outcome === "no_reply") {
          await backend.submitInboundMessage({
            body: {
              relayInstanceId: cfg.relayInstanceId,
              relayMessageId,
              finishedAtMs,
              outcome: "no_reply",
              noReply: result.noReply ?? { reason: "no_message" },
              openclawMeta: buildOpenclawMetaWithTrace(
                normalizeOpenclawMeta(openclawMeta),
                {
                  backendMessageId: msg.messageId,
                  relayMessageId,
                  relayInstanceId: cfg.relayInstanceId,
                  openclawRunId: result.noReply?.runId,
                },
                { deliverySystem, sessionKey: msg.input.sessionKey }
              ),
            },
          });
        } else {
          await backend.submitInboundMessage({
            body: {
              relayInstanceId: cfg.relayInstanceId,
              relayMessageId,
              finishedAtMs,
              outcome: "error",
              error: result.error,
              openclawMeta: buildOpenclawMetaWithTrace(
                normalizeOpenclawMeta(openclawMeta),
                {
                  backendMessageId: msg.messageId,
                  relayMessageId,
                  relayInstanceId: cfg.relayInstanceId,
                  openclawRunId: result.error.runId,
                },
                { deliverySystem, sessionKey: msg.input.sessionKey }
              ),
            },
          });
        }
      } catch (error) {
        taskTimeout.clear();
        unregisterActiveTask();
        if (error instanceof RelayProcessingError) {
          runnerPromise.catch((lateError) => {
            logger.warn(
              {
                event: "message_flow",
                direction: "relay_to_openclaw",
                stage: "late_completion_after_release",
                backendMessageId: msg.messageId,
                relayMessageId,
                error: lateError instanceof Error ? lateError.message : String(lateError),
              },
              "OpenClaw chat task settled after relay released the queue slot"
            );
          });
          if (timedOut) {
            logger.warn(
              {
                event: "relay_queue",
                stage: "active_task_timeout",
                backendMessageId: msg.messageId,
                relayMessageId,
                taskKind,
                taskTimeoutMs: effectiveTaskTimeoutMs,
                durationMs: Date.now() - startedAt,
              },
              "Relay active task timed out; releasing queue slot"
            );
          }
          if (typeof runner.abortTask === "function") {
            await runner.abortTask(msg.messageId, error.code).catch(() => undefined);
          }
        }
        throw error;
      }
    }

    logger.info(
      {
        event: "message_flow",
        direction: "relay_to_backend",
        stage: "callback_sent",
        backendMessageId: msg.messageId,
        relayMessageId,
        durationMs: Date.now() - startedAt,
      },
      "Message flow transition"
    );
  } catch (err) {
    const finishedAtMs = Date.now();
    const normalizedError = normalizeRelayProcessingError(err);
    logger.warn(
      {
        event: "message_flow",
        direction: "relay_to_backend",
        stage: "failed",
        backendMessageId: msg.messageId,
        relayMessageId,
        error: normalizedError.message,
        errorCode: normalizedError.code,
        durationMs: finishedAtMs - startedAt,
      },
      "Message flow transition"
    );
    try {
      await backend.submitInboundMessage({
        body: {
          relayInstanceId: cfg.relayInstanceId,
          relayMessageId,
          finishedAtMs,
          outcome: "error",
          error: {
            code: normalizedError.code,
            message: normalizedError.message,
          },
          openclawMeta: buildOpenclawMetaWithTrace(
            { method: "relay" },
            { backendMessageId: msg.messageId, relayMessageId, relayInstanceId: cfg.relayInstanceId },
            msg.input.kind === "chat"
              ? {
                  deliverySystem: "relay_channel_v2",
                  sessionKey: msg.input.sessionKey,
                }
              : undefined
          ),
        },
      });
    } catch (submitErr) {
      logger.warn(
        {
          event: "message_flow",
          direction: "relay_to_backend",
          stage: "failed",
          backendMessageId: msg.messageId,
          relayMessageId,
          error: submitErr instanceof Error ? submitErr.message : String(submitErr),
        },
        "Message flow transition"
      );
    }
  } finally {
    clearTimeout(watchdog);
  }
}

async function maybeSubmitLowDiskSpaceAlert(input: {
  cfg: {
    relayInstanceId: string;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
  };
  backend: BackendClient;
  correlationMessageId: string;
  parentRelayMessageId: string;
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
}): Promise<void> {
  if (input.cfg.lowDiskAlertEnabled !== true) {
    return;
  }
  const checkedPath = resolveOpenclawStateDir(process.env);
  try {
    const usage = await input.readDiskUsage(checkedPath);
    if (usage.usedPercent < (input.cfg.lowDiskAlertThresholdPercent ?? 80)) {
      return;
    }
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.cfg.relayInstanceId,
        relayMessageId: `${input.parentRelayMessageId}:disk-space-low`,
        finishedAtMs: Date.now(),
        outcome: "technical",
        technical: {
          source: "relay",
          event: "disk.space_low",
          checkedPath,
          thresholdPercent: input.cfg.lowDiskAlertThresholdPercent ?? 80,
          usedPercent: usage.usedPercent,
          usedBytes: usage.usedBytes,
          availableBytes: usage.availableBytes,
          totalBytes: usage.totalBytes,
        },
        openclawMeta: buildOpenclawMetaWithTrace(
          { method: "relay.disk.check" },
          {
            backendMessageId: input.correlationMessageId,
            relayMessageId: `${input.parentRelayMessageId}:disk-space-low`,
            relayInstanceId: input.cfg.relayInstanceId,
          }
        ),
      },
    });
  } catch (error) {
    logger.warn(
      {
        event: "relay_disk_space_check",
        relayInstanceId: input.cfg.relayInstanceId,
        checkedPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "Relay failed to evaluate disk usage"
    );
  }
}

async function readDiskUsageSnapshot(targetPath: string): Promise<DiskUsageSnapshot> {
  const stats = await fs.statfs(targetPath);
  const blockSize = stats.bsize;
  const totalBytes = Number(stats.blocks) * blockSize;
  const availableBytes = Number(stats.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usedPercent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0;
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent,
  };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const method = readNonEmptyString(meta.method);
  const runId = readNonEmptyString(meta.runId);
  const model = readNonEmptyString(meta.model);
  const trace = normalizeOpenclawMetaTrace(meta.trace);
  const artifactDelivery = normalizeArtifactDeliveryMeta(meta.artifactDelivery);
  const deliverySystem = meta.deliverySystem === "relay_channel_v2" ? meta.deliverySystem : undefined;
  const sessionKey = readNonEmptyString(meta.sessionKey);
  const transportChannelId = readNonEmptyString(meta.transportChannelId);
  const transportAccountId = readNonEmptyString(meta.transportAccountId);
  const transportMessageId = readNonEmptyString(meta.transportMessageId);
  const transportDelivered = meta.transportDelivered === true ? true : undefined;
  const normalized = {
    ...(method ? { method } : {}),
    ...(runId ? { runId } : {}),
    ...(model ? { model } : {}),
    ...(artifactDelivery ? { artifactDelivery } : {}),
    ...(trace ? { trace } : {}),
    ...(deliverySystem ? { deliverySystem } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(transportChannelId ? { transportChannelId } : {}),
    ...(transportAccountId ? { transportAccountId } : {}),
    ...(transportMessageId ? { transportMessageId } : {}),
    ...(transportDelivered ? { transportDelivered } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildOpenclawMetaWithTrace(
  meta: Record<string, unknown> | undefined,
  trace: {
    backendMessageId: string;
    relayMessageId: string;
    relayInstanceId: string;
    openclawRunId?: string;
  },
  deliveryOpts?: {
    deliverySystem?: "relay_channel_v2";
    sessionKey?: string;
    transportChannelId?: string;
    transportAccountId?: string;
    transportMessageId?: string;
    transportDelivered?: true;
  }
): Record<string, unknown> {
  const base = normalizeOpenclawMeta(meta) ?? {};
  const fromBase = base.deliverySystem;
  const deliverySystem =
    deliveryOpts?.deliverySystem ?? (fromBase === "relay_channel_v2" ? fromBase : "relay_channel_v2");
  const transportChannelId =
    readNonEmptyString(deliveryOpts?.transportChannelId) ?? readNonEmptyString(base.transportChannelId);
  const sessionKey = readNonEmptyString(deliveryOpts?.sessionKey) ?? readNonEmptyString(base.sessionKey);
  const transportAccountId =
    readNonEmptyString(deliveryOpts?.transportAccountId) ?? readNonEmptyString(base.transportAccountId);
  const transportMessageId =
    readNonEmptyString(deliveryOpts?.transportMessageId) ?? readNonEmptyString(base.transportMessageId);
  const transportDelivered = deliveryOpts?.transportDelivered === true || base.transportDelivered === true;
  return {
    ...base,
    trace: {
      backendMessageId: trace.backendMessageId,
      relayMessageId: trace.relayMessageId,
      relayInstanceId: trace.relayInstanceId,
      ...(trace.openclawRunId ? { openclawRunId: trace.openclawRunId } : {}),
    },
    deliverySystem,
    ...(sessionKey ? { sessionKey } : {}),
    ...(transportChannelId ? { transportChannelId } : {}),
    ...(transportAccountId ? { transportAccountId } : {}),
    ...(transportMessageId ? { transportMessageId } : {}),
    ...(transportDelivered ? { transportDelivered: true } : {}),
  };
}

function readDeliverySystemFromTaskContext(context: unknown): DeliverySystem {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return "relay_channel_v2";
  }
  return "relay_channel_v2";
}

function readTelegramTaskContext(context: unknown):
  | {
      chatId: string;
      messageId?: string;
      chatType?: string;
    }
  | null {
  if (!isPlainObject(context) || context.channel !== "telegram" || !isPlainObject(context.telegram)) {
    return null;
  }
  const chatId = readNonEmptyString(context.telegram.chatId);
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    ...(readNonEmptyString(context.telegram.messageId) ? { messageId: readNonEmptyString(context.telegram.messageId)! } : {}),
    ...(readNonEmptyString(context.telegram.chatType) ? { chatType: readNonEmptyString(context.telegram.chatType)! } : {}),
  };
}

function readWhatsAppPersonalTaskContext(context: unknown):
  | {
      chatId: string;
      messageId?: string;
      fromPhoneNumber?: string;
    }
  | null {
  if (!isPlainObject(context)) {
    return null;
  }
  const payload = isPlainObject(context.whatsappPersonal) ? context.whatsappPersonal : null;
  if (!payload) {
    return null;
  }
  if (context.channel !== undefined && context.channel !== "whatsapp_personal") {
    return null;
  }
  const chatId = readNonEmptyString(payload.chatId) ?? readNonEmptyString(payload.fromChatId);
  if (!chatId) {
    return null;
  }
  return {
    chatId,
    ...(readNonEmptyString(payload.messageId)
      ? { messageId: readNonEmptyString(payload.messageId)! }
      : readNonEmptyString(payload.providerMessageId)
        ? { messageId: readNonEmptyString(payload.providerMessageId)! }
        : {}),
    ...(readNonEmptyString(payload.fromPhoneNumber)
      ? { fromPhoneNumber: readNonEmptyString(payload.fromPhoneNumber)! }
      : {}),
  };
}

function maybeDeliverRelayChannelReplyDirectly(input: {
  backend: BackendClient;
  context: unknown;
  sessionKey: string;
  reply: Extract<RelayInboundMessageRequest, { outcome: "reply" }>["reply"];
  backendMessageId: string;
  relayMessageId: string;
}): {
  transportDelivered: true;
  transportChannelId: "telegram" | "whatsapp_personal";
  transportAccountId: "default";
  transportMessageId?: string;
} | null {
  void input.backend;
  const telegram = readTelegramTaskContext(input.context);
  const whatsAppPersonal = telegram ? null : readWhatsAppPersonalTaskContext(input.context);
  const text = extractReplyText(input.reply.message);
  const mediaCount = Array.isArray(input.reply.media) ? input.reply.media.length : 0;
  if (!text && mediaCount === 0) {
    return null;
  }
  if (!telegram && !whatsAppPersonal) {
    if (!isTransportBackedSessionKey(input.sessionKey)) {
      return null;
    }
    throw new RelayProcessingError({
      code: "RELAY_DIRECT_TRANSPORT_DELIVERY_FAILED",
      message: "Relay direct delivery failed: user-facing reply has no messenger transport context",
    });
  }

  logger.info(
    {
      event: "message_flow",
      direction: "openclaw_to_transport",
      stage: "sdk_delivered",
      backendMessageId: input.backendMessageId,
      relayMessageId: input.relayMessageId,
      transport: telegram ? "telegram" : "whatsapp_personal",
      chatId: telegram?.chatId ?? whatsAppPersonal?.chatId ?? null,
      textLen: text.length,
      mediaCount,
    },
    "Message flow transition"
  );

  return {
    transportDelivered: true,
    transportChannelId: telegram ? "telegram" : "whatsapp_personal",
    transportAccountId: "default",
  };
}

function isTransportBackedSessionKey(sessionKey: string): boolean {
  return (
    sessionKey.startsWith("tg:") ||
    sessionKey.startsWith("whatsapp:") ||
    sessionKey.startsWith("whatsapp-personal:")
  );
}

function normalizeRelayProcessingError(error: unknown): {
  code: RelayProcessingErrorCode;
  message: string;
} {
  if (error instanceof RelayProcessingError) {
    return {
      code: error.code,
      message: error.message.trim() || "Relay failed to process message",
    };
  }
  if (error instanceof Error) {
    return {
      code: "RELAY_INTERNAL_ERROR",
      message: error.message.trim() || "Relay failed to process message",
    };
  }
  return {
    code: "RELAY_INTERNAL_ERROR",
    message: formatUnknownErrorMessage(error),
  };
}

function formatUnknownErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim() || "Relay failed to process message";
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error == null) {
    return "Relay failed to process message";
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : "Relay failed to process message";
  } catch {
    return "Relay failed to process message";
  }
}

function normalizeOpenclawMetaTrace(trace: unknown): Record<string, string> | undefined {
  if (!isPlainObject(trace)) return undefined;
  const backendMessageId = readNonEmptyString(trace.backendMessageId);
  const relayMessageId = readNonEmptyString(trace.relayMessageId);
  const relayInstanceId = readNonEmptyString(trace.relayInstanceId);
  const openclawRunId = readNonEmptyString(trace.openclawRunId);
  const normalized = {
    ...(backendMessageId ? { backendMessageId } : {}),
    ...(relayMessageId ? { relayMessageId } : {}),
    ...(relayInstanceId ? { relayInstanceId } : {}),
    ...(openclawRunId ? { openclawRunId } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeArtifactDeliveryMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const stage = readNonEmptyString(meta.stage);
  const originalRunId = readNonEmptyString(meta.originalRunId);
  const retryRunId = readNonEmptyString(meta.retryRunId);
  const retryOutcome = readNonEmptyString(meta.retryOutcome);
  const unresolvedCount =
    typeof meta.unresolvedCount === "number" && Number.isFinite(meta.unresolvedCount)
      ? meta.unresolvedCount
      : undefined;
  const unresolvedReasons = isPlainObject(meta.unresolvedReasons)
    ? Object.fromEntries(
        Object.entries(meta.unresolvedReasons).filter(
          (entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number"
        )
      )
    : undefined;
  const normalized = {
    ...(stage ? { stage } : {}),
    ...(originalRunId ? { originalRunId } : {}),
    ...(retryRunId ? { retryRunId } : {}),
    ...(retryOutcome ? { retryOutcome } : {}),
    ...(unresolvedCount !== undefined ? { unresolvedCount } : {}),
    ...(unresolvedReasons && Object.keys(unresolvedReasons).length > 0 ? { unresolvedReasons } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function buildReplyPayload(reply: {
  message: unknown;
  runId: string;
  artifacts?: Array<{
    path: string;
    fileName: string;
    kind: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }>;
  media?: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
}): Promise<Extract<RelayInboundMessageRequest, { outcome: "reply" }>["reply"]> {
  const normalizedMessage = normalizeReplyMessage(reply.message);
  const extracted = await extractInlineReplyMedia(normalizedMessage);
  const payload: Extract<RelayInboundMessageRequest, { outcome: "reply" }>["reply"] = {
    ...(isPlainObject(reply) ? reply : {}),
    runId: reply.runId,
    message: extracted.message,
  };
  const allArtifacts = normalizeReplyArtifacts([
    ...(Array.isArray(reply.artifacts) ? reply.artifacts : []),
    ...(Array.isArray(reply.media) ? reply.media.map((item) => toReplyArtifact(item)) : []),
    ...extracted.media.map((item) => toReplyArtifact(item)),
  ]);
  if (allArtifacts.length > 0) {
    payload.artifacts = allArtifacts;
    payload.media = allArtifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    }));
  }
  return payload;
}

function extractReplyText(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (!isPlainObject(message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (typeof message.text === "string") return message.text.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function inferArtifactKind(contentType: string): "image" | "video" | "audio" | "file" {
  const normalized = contentType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "file";
}

function toReplyArtifact(item: {
  path: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  kind?: "image" | "video" | "audio" | "file";
}): {
  path: string;
  fileName: string;
  kind: "image" | "video" | "audio" | "file";
  contentType: string;
  sizeBytes: number;
} {
  return {
    path: item.path,
    fileName: item.fileName,
    kind: item.kind ?? inferArtifactKind(item.contentType),
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  };
}

function normalizeReplyArtifacts(
  artifacts: Array<{
    path: string;
    fileName: string;
    kind?: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }>
): Array<{
  path: string;
  fileName: string;
  kind: "image" | "video" | "audio" | "file";
  contentType: string;
  sizeBytes: number;
}> {
  const normalized: Array<{
    path: string;
    fileName: string;
    kind: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }> = [];
  const seen = new Set<string>();

  for (const item of artifacts) {
    const path = readNonEmptyString(item.path);
    const fileName = readNonEmptyString(item.fileName);
    const kind = item.kind ?? (item.contentType ? inferArtifactKind(item.contentType) : "file");
    const contentType = readNonEmptyString(item.contentType);
    const sizeBytes = Number.isFinite(item.sizeBytes) ? Math.trunc(item.sizeBytes) : 0;

    if (!path || !fileName || !contentType || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      continue;
    }
    const dedupeKey = `${path}\u0000${fileName}\u0000${kind}\u0000${contentType}\u0000${sizeBytes}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      path,
      fileName,
      kind,
      contentType,
      sizeBytes,
    });
  }

  return normalized;
}

async function extractInlineReplyMedia(message: unknown): Promise<{
  message: unknown;
  media: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
}> {
  if (!isPlainObject(message) || !Array.isArray(message.content)) {
    return { message, media: [] };
  }
  const content: unknown[] = [];
  const media: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }> = [];
  for (const part of message.content) {
    const extracted = await extractInlineReplyMediaPart(part);
    if (extracted.media) {
      media.push(extracted.media);
      continue;
    }
    content.push(extracted.part);
  }
  return {
    message: {
      ...message,
      content,
    },
    media,
  };
}

async function extractInlineReplyMediaPart(part: unknown): Promise<{
  part: unknown;
  media?: {
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  };
}> {
  if (!isPlainObject(part) || part.type !== "image") {
    return { part };
  }
  const rawData = readNonEmptyString(part.data);
  if (!rawData) {
    return { part };
  }
  const parsed = parseInlineImagePayload(rawData, readNonEmptyString(part.mimeType));
  if (!parsed) {
    return { part };
  }
  const persisted = await persistInlineReplyMedia({
    payload: parsed.dataB64,
    contentType: parsed.contentType,
    fileName: readNonEmptyString(part.fileName),
  });
  const sanitizedPart = { ...part };
  delete sanitizedPart.data;
  return {
    part: {
      ...sanitizedPart,
      dataPreview: {
        dataPrefix: parsed.dataB64.slice(0, 128),
        dataLength: parsed.dataB64.length,
        truncated: true,
      },
    },
    media: persisted,
  };
}

function parseInlineImagePayload(
  value: string,
  mimeType: string | undefined
): { dataB64: string; contentType: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dataUrlMatch = /^data:([^;]+);base64,(.*)$/i.exec(trimmed);
  if (dataUrlMatch?.[2]) {
    return {
      contentType: (dataUrlMatch[1] ?? mimeType ?? "image/png").trim() || "image/png",
      dataB64: dataUrlMatch[2].trim(),
    };
  }
  return {
    contentType: mimeType?.trim() || "image/png",
    dataB64: trimmed,
  };
}

async function persistInlineReplyMedia(input: {
  payload: string;
  contentType: string;
  fileName?: string;
}): Promise<{ path: string; fileName: string; contentType: string; sizeBytes: number }> {
  const stateDir = resolveOpenclawStateDir(process.env);
  const workspaceDir = path.join(stateDir, "workspace", "files", "inline-reply");
  await fs.mkdir(workspaceDir, { recursive: true });
  const ext = inferFileExtension(input.fileName, input.contentType);
  const fileName = sanitizeFileName(input.fileName, ext);
  const uniqueName = `${Date.now()}-${randomUUID()}-${fileName}`;
  const absolutePath = path.join(workspaceDir, uniqueName);
  const buffer = Buffer.from(input.payload, "base64");
  await fs.writeFile(absolutePath, buffer);
  return {
    path: path.posix.join("files", "inline-reply", uniqueName),
    fileName,
    contentType: input.contentType,
    sizeBytes: buffer.byteLength,
  };
}

function inferFileExtension(fileName: string | undefined, contentType: string): string {
  const ext = path.extname((fileName ?? "").trim()).replace(/^\./, "");
  if (ext) return ext;
  const normalized = contentType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  return "png";
}

function sanitizeFileName(fileName: string | undefined, ext: string): string {
  const rawBase = path.basename((fileName ?? "").trim()) || `image.${ext}`;
  const safe = rawBase.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe || `image.${ext}`;
}

function normalizeReplyMessage(message: unknown): unknown {
  if (typeof message === "string") {
    return { role: "assistant", content: message };
  }
  if (!isPlainObject(message)) {
    return message;
  }
  if ("content" in message) {
    const role =
      typeof (message as { role?: unknown }).role === "string"
        ? (message as { role: string }).role
        : "assistant";
    return { ...message, role };
  }
  const text = (message as { text?: unknown }).text;
  if (typeof text === "string" && text.trim().length > 0) {
    const role =
      typeof (message as { role?: unknown }).role === "string"
        ? (message as { role: string }).role
        : "assistant";
    return { ...message, role, content: text };
  }
  return message;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.max(1, timeoutMs);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
