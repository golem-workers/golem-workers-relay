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

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  return isPlainObject(meta) ? meta : undefined;
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
