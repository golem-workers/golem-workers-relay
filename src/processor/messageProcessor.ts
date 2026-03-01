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
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
};

export function createMessageProcessor(input: MessageProcessorInput): (msg: InboundPushMessage) => Promise<void> {
  const { cfg, gateway, runner, backend } = input;
  return async (msg: InboundPushMessage): Promise<void> => {
    const startedAt = Date.now();
    const relayMessageId = `relay_${randomUUID()}`;
    try {
      if (cfg.devLogEnabled) {
        logger.debug(
          {
            messageId: msg.messageId,
            relayMessageId,
            kind: msg.input.kind,
            sessionKey: msg.input.kind === "chat" ? msg.input.sessionKey : null,
            messageLen: msg.input.kind === "chat" ? msg.input.messageText.length : null,
            messagePreview: msg.input.kind === "chat" ? makeTextPreview(msg.input.messageText, cfg.devLogTextMaxLen) : null,
          },
          "Push message received for processing"
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
            openclawMeta: { method: "connect" },
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
            openclawMeta: { method: "session_new" },
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
              openclawMeta: normalizeOpenclawMeta(openclawMeta),
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
              openclawMeta: normalizeOpenclawMeta(openclawMeta),
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
              openclawMeta: normalizeOpenclawMeta(openclawMeta),
            },
          });
        }
      }

      logger.info({ messageId: msg.messageId, relayMessageId, durationMs: Date.now() - startedAt }, "Push message processed");
    } catch (err) {
      const finishedAtMs = Date.now();
      logger.warn(
        { messageId: msg.messageId, relayMessageId, err: err instanceof Error ? err.message : String(err) },
        "Push message processing failed"
      );
      try {
        await backend.submitInboundMessage({
          body: {
            relayInstanceId: cfg.relayInstanceId,
            relayMessageId,
            finishedAtMs,
            outcome: "error",
            error: { code: "RELAY_INTERNAL_ERROR", message: "Relay failed to process message" },
            openclawMeta: { method: "relay" },
          },
        });
      } catch (submitErr) {
        logger.warn(
          { messageId: msg.messageId, err: submitErr instanceof Error ? submitErr.message : String(submitErr) },
          "Failed to submit push error result"
        );
      }
    }
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function readCounter(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
  }
  return 0;
}

function readTotals(snapshot: unknown): { input: number; output: number; cacheRead: number; totalTokens: number } {
  if (!isPlainObject(snapshot)) return { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  const totals = isPlainObject(snapshot.totals) ? snapshot.totals : undefined;
  if (!totals) return { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
  return {
    input: readCounter(totals, ["input", "inputTokens", "promptTokens", "input_tokens", "prompt_tokens"]),
    output: readCounter(totals, ["output", "outputTokens", "completionTokens", "output_tokens", "completion_tokens"]),
    cacheRead: readCounter(totals, ["cacheRead", "cacheReadTokens", "cache_read", "cache_read_tokens"]),
    totalTokens: readCounter(totals, ["totalTokens", "total", "tokens", "total_tokens"]),
  };
}

function normalizeModelName(provider?: string, model?: string): string | undefined {
  if (!provider && !model) return undefined;
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function pickModelFromOutgoing(snapshot: unknown): string | undefined {
  if (!isPlainObject(snapshot)) return undefined;
  const aggregates = isPlainObject(snapshot.aggregates) ? snapshot.aggregates : undefined;
  const byModel = aggregates && Array.isArray(aggregates.byModel) ? aggregates.byModel : [];
  for (const row of byModel) {
    if (!isPlainObject(row)) continue;
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    const model = typeof row.model === "string" ? row.model.trim() : "";
    const normalized = normalizeModelName(provider || undefined, model || undefined);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const next: Record<string, unknown> = { ...meta };
  if (isPlainObject(next.usage)) return next;

  const incoming = readTotals(next.usageIncoming);
  const outgoing = readTotals(next.usageOutgoing);
  const inputTokens = Math.max(0, Math.trunc(outgoing.input - incoming.input));
  const outputTokens = Math.max(0, Math.trunc(outgoing.output - incoming.output));
  const cacheReadTokens = Math.max(0, Math.trunc(outgoing.cacheRead - incoming.cacheRead));
  const totalTokens = Math.max(
    0,
    Math.trunc((outgoing.totalTokens || inputTokens + outputTokens) - (incoming.totalTokens || 0))
  );

  const hasUsage = inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || totalTokens > 0;
  if (!hasUsage) return next;

  const modelRaw = typeof next.model === "string" ? next.model.trim() : "";
  const model = modelRaw || pickModelFromOutgoing(next.usageOutgoing);
  next.usage = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    ...(model ? { model } : {}),
  };
  if (!modelRaw && model) {
    next.model = model;
  }
  return next;
}

function normalizeReply(message: unknown): unknown {
  if (message && typeof message === "object") {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return { text };
    }
  }
  return { message };
}

function buildReplyPayload(reply: { message: unknown; runId: string; media?: unknown[] }): unknown {
  const normalized = normalizeReply(reply.message) as { text?: unknown };
  const payload: Record<string, unknown> = {
    runId: reply.runId,
    message: reply.message,
  };
  if (typeof normalized.text === "string" && normalized.text.trim()) {
    payload.text = normalized.text;
  }
  if (Array.isArray(reply.media) && reply.media.length > 0) {
    payload.media = reply.media;
  }
  return payload;
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
