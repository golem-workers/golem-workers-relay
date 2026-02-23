import "dotenv/config";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { loadRelayConfig } from "./config/env.js";
import { resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { type AudioTaskMedia, transcribeAudioWithDeepgram } from "./openclaw/transcription.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { startPushServer } from "./push/pushServer.js";

function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

async function main(): Promise<void> {
  const cfg = loadRelayConfig(process.env);
  const openclaw = resolveOpenclawConfig(process.env, {
    gatewayWsUrl: cfg.openclaw.gatewayWsUrl,
  });
  logger.info(
    {
      pid: process.pid,
      relayInstanceId: cfg.relayInstanceId,
      backendBaseUrl: cfg.backendBaseUrl,
      gatewayWsUrl: openclaw.gateway.wsUrl,
      openclawConfigPath: openclaw.configPath,
      maxTasks: cfg.maxTasks,
      waitSeconds: cfg.waitSeconds,
      concurrency: cfg.concurrency,
      pushPort: cfg.pushPort,
      pushPath: cfg.pushPath,
    },
    "Relay starting"
  );

  const backend = new BackendClient({
    baseUrl: cfg.backendBaseUrl,
    relayToken: cfg.relayToken,
    devLogEnabled: cfg.devLogEnabled,
  });

  let chatRunner: ChatRunner | null = null;
  const transcribeAudio: (input: {
    media: AudioTaskMedia;
    apiKey: string;
    language?: string;
    timeoutMs: number;
  }) => Promise<string> =
    cfg.stt.provider === "openai"
      ? (input) =>
          transcribeAudioWithOpenAi({
            ...input,
            model: cfg.stt.openaiModel,
          })
      : transcribeAudioWithDeepgram;

  const sttApiKey = cfg.stt.provider === "openai" ? cfg.stt.openaiApiKey : cfg.stt.deepgramApiKey;
  const sttLanguage = cfg.stt.provider === "openai" ? cfg.stt.openaiLanguage : undefined;

  const gateway = new GatewayClient({
    url: openclaw.gateway.wsUrl,
    token: openclaw.gateway.auth.token,
    password: openclaw.gateway.auth.password,
    instanceId: cfg.relayInstanceId,
    role: "operator",
    scopes: cfg.openclaw.scopes,
    onEvent: (evt) => chatRunner?.handleEvent(evt),
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    devLogGatewayFrames: cfg.devLogGatewayFrames,
  });
  chatRunner = new ChatRunner(gateway, {
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    transcription: {
      apiKey: sttApiKey,
      language: sttLanguage,
      timeoutMs: cfg.stt.timeoutMs,
    },
    transcribeAudio,
  });

  const stop = createStopSignal();
  await ensureGatewayConnected(gateway, stop);
  const runner = chatRunner;
  if (!runner) {
    throw new Error("ChatRunner not initialized");
  }

  const queue: InboundPushMessage[] = [];
  let inFlight = 0;
  let shuttingDown = false;

  const processOne = async (msg: InboundPushMessage): Promise<void> => {
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
            openclawMeta: { method: "connect", backendMessageId: msg.messageId },
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
              openclawMeta: { ...((openclawMeta as Record<string, unknown>) ?? {}), backendMessageId: msg.messageId },
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
              openclawMeta: { ...((openclawMeta as Record<string, unknown>) ?? {}), backendMessageId: msg.messageId },
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
              openclawMeta: { ...((openclawMeta as Record<string, unknown>) ?? {}), backendMessageId: msg.messageId },
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
            openclawMeta: { method: "relay", backendMessageId: msg.messageId },
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

  const pump = () => {
    if (shuttingDown) return;
    while (inFlight < cfg.concurrency && queue.length > 0) {
      const next = queue.shift();
      if (!next) return;
      inFlight += 1;
      void processOne(next).finally(() => {
        inFlight -= 1;
        pump();
      });
    }
  };

  const server = startPushServer({
    port: cfg.pushPort,
    path: cfg.pushPath,
    relayToken: cfg.relayToken,
    onMessage: async (message) => {
      await Promise.resolve();
      queue.push(message);
      pump();
    },
  });

  await waitForStop(stop);
  shuttingDown = true;
  server.close();
  gateway.stop();
  logger.info("Relay stopped");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Relay crashed");
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createStopSignal() {
  const state = { stopped: false };
  const stop = () => {
    state.stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return state;
}

async function ensureGatewayConnected(gateway: GatewayClient, stop: { stopped: boolean }) {
  while (!stop.stopped) {
    try {
      await gateway.start();
      return;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Gateway connect failed; retrying");
      await sleep(1000);
    }
  }
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
  // Keep back-compat with the old `{ text }` short form, but never drop `message`/`media`.
  const normalized = normalizeReply(reply.message) as { text?: unknown; message?: unknown };
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

async function waitForStop(stop: { stopped: boolean }): Promise<void> {
  while (!stop.stopped) {
    await sleep(200);
  }
}

