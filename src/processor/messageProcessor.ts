import { randomUUID } from "node:crypto";
import { type BackendClient } from "../backend/backendClient.js";
import { type InboundPushMessage } from "../backend/types.js";
import { logger } from "../logger.js";
import { type ChatRunner } from "../openclaw/chatRunner.js";
import { type GatewayClient } from "../openclaw/gatewayClient.js";
import { makeTextPreview } from "../common/utils/text.js";

type MessageProcessorInput = {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    chatBatchDebounceMs: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
};

export function createMessageProcessor(input: MessageProcessorInput): (msg: InboundPushMessage) => Promise<void> {
  const { cfg, gateway, runner, backend } = input;
  const chatBatchesBySession = new Map<string, ChatBatchState>();
  const chatBatchDebounceMs = Math.max(0, Math.trunc(cfg.chatBatchDebounceMs));

  return async (msg: InboundPushMessage): Promise<void> => {
    if (msg.input.kind !== "chat" || chatBatchDebounceMs === 0) {
      await processSingleMessage({ cfg, gateway, runner, backend, msg });
      return;
    }
    await enqueueChatBatch({
      sessionKey: msg.input.sessionKey,
      msg,
      debounceMs: chatBatchDebounceMs,
      chatBatchesBySession,
      flush: async (items) => {
        await flushChatBatch({ cfg, gateway, runner, backend, items });
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
    chatBatchDebounceMs: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  items: ChatBatchItem[];
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
        }
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
    chatBatchDebounceMs: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  msg: InboundPushMessage;
}): Promise<void> {
  const { cfg, gateway, runner, backend, msg } = input;
    const startedAt = Date.now();
    const relayMessageId = `relay_${randomUUID()}`;
    try {
      if (cfg.devLogEnabled) {
        logger.info(
          {
            event: "message_flow",
            direction: "backend_to_relay",
            stage: "received",
            backendMessageId: msg.messageId,
            relayMessageId,
            kind: msg.input.kind,
            sessionKey: msg.input.kind === "chat" ? msg.input.sessionKey : null,
            textLen: msg.input.kind === "chat" ? msg.input.messageText.length : null,
            textPreview: msg.input.kind === "chat" ? makeTextPreview(msg.input.messageText, cfg.devLogTextMaxLen) : null,
          },
          "Message flow transition"
        );
      }

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
      } else {
        const { result, openclawMeta } = await runner.runChatTask({
          taskId: msg.messageId,
          sessionKey: msg.input.sessionKey,
          messageText: msg.input.messageText,
          media: msg.input.media,
          timeoutMs: cfg.taskTimeoutMs,
        });
        const finishedAtMs = Date.now();
        if (result.outcome === "reply") {
          await backend.submitInboundMessage({
            body: {
              relayInstanceId: cfg.relayInstanceId,
              relayMessageId,
              finishedAtMs,
              outcome: "reply",
              reply: buildReplyPayload(result.reply),
              openclawMeta: buildOpenclawMetaWithTrace(normalizeOpenclawMeta(openclawMeta), {
                backendMessageId: msg.messageId,
                relayMessageId,
                relayInstanceId: cfg.relayInstanceId,
                openclawRunId: result.reply.runId,
              }),
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
              openclawMeta: buildOpenclawMetaWithTrace(normalizeOpenclawMeta(openclawMeta), {
                backendMessageId: msg.messageId,
                relayMessageId,
                relayInstanceId: cfg.relayInstanceId,
                openclawRunId: result.noReply?.runId,
              }),
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
              openclawMeta: buildOpenclawMetaWithTrace(normalizeOpenclawMeta(openclawMeta), {
                backendMessageId: msg.messageId,
                relayMessageId,
                relayInstanceId: cfg.relayInstanceId,
                openclawRunId: result.error.runId,
              }),
            },
          });
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
      logger.warn(
        {
          event: "message_flow",
          direction: "relay_to_backend",
          stage: "failed",
          backendMessageId: msg.messageId,
          relayMessageId,
          error: err instanceof Error ? err.message : String(err),
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
            error: { code: "RELAY_INTERNAL_ERROR", message: "Relay failed to process message" },
            openclawMeta: buildOpenclawMetaWithTrace(
              { method: "relay" },
              { backendMessageId: msg.messageId, relayMessageId, relayInstanceId: cfg.relayInstanceId }
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
    }
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const normalized = { ...meta };
  if (!("usage" in normalized)) {
    const usage = deriveCanonicalUsageFromSessions(meta);
    if (usage) {
      normalized.usage = usage;
    }
  }
  return normalized;
}

function buildOpenclawMetaWithTrace(
  meta: Record<string, unknown> | undefined,
  trace: {
    backendMessageId: string;
    relayMessageId: string;
    relayInstanceId: string;
    openclawRunId?: string;
  }
): Record<string, unknown> {
  const base = meta ? { ...meta } : {};
  return {
    ...base,
    trace: {
      backendMessageId: trace.backendMessageId,
      relayMessageId: trace.relayMessageId,
      relayInstanceId: trace.relayInstanceId,
      ...(trace.openclawRunId ? { openclawRunId: trace.openclawRunId } : {}),
    },
  };
}

function buildReplyPayload(reply: { message: unknown; runId: string; media?: unknown[] }): unknown {
  const payload: Record<string, unknown> = {
    ...(isPlainObject(reply) ? reply : {}),
    runId: reply.runId,
    message: normalizeReplyMessage(reply.message),
  };
  if (Array.isArray(reply.media) && reply.media.length > 0) {
    payload.media = reply.media;
  }
  return payload;
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

function deriveCanonicalUsageFromSessions(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const incoming = readUsageTotals((meta as { usageIncoming?: unknown }).usageIncoming);
  const outgoing = readUsageTotals((meta as { usageOutgoing?: unknown }).usageOutgoing);
  if (!incoming && !outgoing) return undefined;

  const inputTokens = Math.max(0, Math.trunc((outgoing?.input ?? 0) - (incoming?.input ?? 0)));
  const outputTokens = Math.max(0, Math.trunc((outgoing?.output ?? 0) - (incoming?.output ?? 0)));
  const cacheReadTokens = Math.max(
    0,
    Math.trunc((outgoing?.cacheRead ?? 0) - (incoming?.cacheRead ?? 0))
  );
  const totalTokens = Math.max(
    0,
    Math.trunc((outgoing?.totalTokens ?? inputTokens + outputTokens) - (incoming?.totalTokens ?? 0))
  );
  const model = pickModelFromUsageOutgoing((meta as { usageOutgoing?: unknown }).usageOutgoing);
  const hasSignal =
    inputTokens > 0 ||
    outputTokens > 0 ||
    cacheReadTokens > 0 ||
    totalTokens > 0 ||
    model !== undefined;
  if (!hasSignal) return undefined;

  return {
    ...(model ? { model } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
  };
}

function readUsageTotals(source: unknown):
  | { input: number; output: number; cacheRead: number; totalTokens: number }
  | undefined {
  if (!isPlainObject(source)) return undefined;
  const totals = (source as { totals?: unknown }).totals;
  if (!isPlainObject(totals)) return undefined;
  return {
    input: readUsageNumber(totals.input),
    output: readUsageNumber(totals.output),
    cacheRead: readUsageNumber((totals as { cacheRead?: unknown }).cacheRead),
    totalTokens: readUsageNumber((totals as { totalTokens?: unknown }).totalTokens),
  };
}

function pickModelFromUsageOutgoing(source: unknown): string | undefined {
  if (!isPlainObject(source)) return undefined;
  const aggregates = (source as { aggregates?: unknown }).aggregates;
  if (!isPlainObject(aggregates)) return undefined;
  const byModel = (aggregates as { byModel?: unknown }).byModel;
  if (!isUnknownArray(byModel) || byModel.length === 0) return undefined;
  const first = byModel[0];
  if (!isPlainObject(first)) return undefined;
  const provider = readNonEmptyString((first as { provider?: unknown }).provider);
  const model = readNonEmptyString((first as { model?: unknown }).model);
  if (provider && model) return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  return model ?? undefined;
}

function readUsageNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
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
