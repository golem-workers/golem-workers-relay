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
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  return isPlainObject(meta) ? meta : undefined;
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
    runId: reply.runId,
    message: reply.message,
  };
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
