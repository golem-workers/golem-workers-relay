import "dotenv/config";
import { logger } from "./logger.js";
import { loadRelayConfig } from "./config/env.js";
import { resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { type AudioTaskMedia, transcribeAudioWithDeepgram } from "./openclaw/transcription.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { PushServerHttpError, startPushServer } from "./push/pushServer.js";
import { InMemoryTaskQueue, QueueClosedError, QueueFullError } from "./queue/inMemoryTaskQueue.js";
import { createMessageProcessor } from "./processor/messageProcessor.js";

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
      pushRateLimitPerSecond: cfg.pushRateLimitPerSecond,
      pushMaxConcurrentRequests: cfg.pushMaxConcurrentRequests,
      pushMaxQueue: cfg.pushMaxQueue,
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

  let shuttingDown = false;
  const processOne = createMessageProcessor({
    cfg: {
      relayInstanceId: cfg.relayInstanceId,
      taskTimeoutMs: cfg.taskTimeoutMs,
      devLogEnabled: cfg.devLogEnabled,
      devLogTextMaxLen: cfg.devLogTextMaxLen,
    },
    gateway,
    runner,
    backend,
  });

  const queue = new InMemoryTaskQueue<InboundPushMessage>({
    concurrency: cfg.concurrency,
    maxQueue: cfg.pushMaxQueue,
    processor: processOne,
  });

  const server = startPushServer({
    port: cfg.pushPort,
    path: cfg.pushPath,
    relayToken: cfg.relayToken,
    rateLimitPerSecond: cfg.pushRateLimitPerSecond,
    maxConcurrentRequests: cfg.pushMaxConcurrentRequests,
    getHealth: () => {
      const queueState = queue.getState();
      const backendResilience = backend.getResilienceState();
      return {
        ok: true,
        ready: !shuttingDown && gateway.isReady() && queueState.queueLength < queueState.maxQueue,
        details: {
          shuttingDown,
          gatewayReady: gateway.isReady(),
          queueLength: queueState.queueLength,
          inFlight: queueState.inFlight,
          maxQueue: queueState.maxQueue,
          backendResilience,
        },
      };
    },
    onMessage: (message) => {
      try {
        queue.enqueue(message);
      } catch (error) {
        if (error instanceof QueueClosedError) {
          throw new PushServerHttpError({
            statusCode: 503,
            code: "SHUTTING_DOWN",
            message: "Relay is shutting down",
          });
        }
        if (error instanceof QueueFullError) {
          throw new PushServerHttpError({
            statusCode: 429,
            code: "QUEUE_FULL",
            message: "Relay queue is full",
            details: { maxQueue: error.maxQueue },
          });
        }
        throw error;
      }
      return Promise.resolve();
    },
  });

  await waitForStop(stop);
  shuttingDown = true;
  queue.stopAccepting();
  const drainState = queue.getState();
  logger.info({ inFlight: drainState.inFlight, queueLength: drainState.queueLength }, "Stop signal received; draining relay queue");
  await closeServer(server);
  const drained = await queue.drain(Math.max(15_000, cfg.taskTimeoutMs * 2));
  if (!drained) {
    const finalState = queue.getState();
    logger.warn(
      { inFlight: finalState.inFlight, queueLength: finalState.queueLength },
      "Relay drain timeout reached; forcing shutdown"
    );
  }
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

async function waitForStop(stop: { stopped: boolean }): Promise<void> {
  while (!stop.stopped) {
    await sleep(200);
  }
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

