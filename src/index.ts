import "dotenv/config";
import { logger } from "./logger.js";
import { loadRelayConfig } from "./config/env.js";
import { resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { PushServerHttpError, startPushServer } from "./push/pushServer.js";
import { InMemoryTaskQueue, QueueClosedError, QueueFullError } from "./queue/inMemoryTaskQueue.js";
import { createMessageProcessor } from "./processor/messageProcessor.js";
import {
  LOCAL_PROXY_LISTEN_HOST,
  startGoogleAiProxyServer,
  startOpenRouterProxyServer,
} from "./openrouter/proxyServer.js";
import { createGatewayEventForwarder } from "./openclaw/gatewayEventForwarder.js";
import { createOpenclawConnectionStatusReporter } from "./openclaw/connectionStatusReporter.js";

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
      concurrency: cfg.concurrency,
      pushPort: cfg.pushPort,
      pushPath: cfg.pushPath,
      openrouterProxyEnabled: cfg.openrouterProxy.enabled,
      openrouterProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      openrouterProxyPort: cfg.openrouterProxy.port,
      openrouterProxyPathPrefix: cfg.openrouterProxy.pathPrefix,
      googleAiProxyEnabled: cfg.googleAiProxy.enabled,
      googleAiProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      googleAiProxyPort: cfg.googleAiProxy.port,
      googleAiProxyPathPrefix: cfg.googleAiProxy.pathPrefix,
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
  const reportOpenclawConnectionStatus = createOpenclawConnectionStatusReporter({
    backend,
    relayInstanceId: cfg.relayInstanceId,
  });

  let chatRunner: ChatRunner | null = null;
  const forwardGatewayEvent = createGatewayEventForwarder({
    relayInstanceId: cfg.relayInstanceId,
    backend,
    forwardFinalOnly: cfg.openclawForwardFinalOnly,
    getChatRunTrace: (runId) => chatRunner?.getRunTrace(runId) ?? null,
  });

  const gateway = new GatewayClient({
    url: openclaw.gateway.wsUrl,
    token: openclaw.gateway.auth.token,
    password: openclaw.gateway.auth.password,
    instanceId: cfg.relayInstanceId,
    role: "operator",
    scopes: cfg.openclaw.scopes,
    onEvent: (evt) => {
      chatRunner?.handleEvent(evt);
      void forwardGatewayEvent(evt);
    },
    onConnectionStateChange: (state) => {
      void reportOpenclawConnectionStatus(state);
    },
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    devLogGatewayFrames: cfg.devLogGatewayFrames,
  });
  chatRunner = new ChatRunner(gateway, {
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    transcription: {
      baseUrl: cfg.stt.baseUrl,
      relayToken: cfg.relayToken,
      model: cfg.stt.model,
      timeoutMs: cfg.stt.timeoutMs,
    },
    transcribeAudio: transcribeAudioWithOpenAi,
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
      chatBatchDebounceMs: cfg.chatBatchDebounceMs,
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
  const openrouterProxyServer = cfg.openrouterProxy.enabled
    ? startOpenRouterProxyServer({
        port: cfg.openrouterProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.openrouterProxy.pathPrefix,
        backendPathPrefix: cfg.openrouterProxy.backendPathPrefix,
      })
    : null;
  const googleAiProxyServer = cfg.googleAiProxy.enabled
    ? startGoogleAiProxyServer({
        port: cfg.googleAiProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.googleAiProxy.pathPrefix,
        backendPathPrefix: cfg.googleAiProxy.backendPathPrefix,
      })
    : null;

  await waitForStop(stop);
  shuttingDown = true;
  queue.stopAccepting();
  const drainState = queue.getState();
  logger.info({ inFlight: drainState.inFlight, queueLength: drainState.queueLength }, "Stop signal received; draining relay queue");
  await closeServer(server);
  if (openrouterProxyServer) {
    await closeServer(openrouterProxyServer);
  }
  if (googleAiProxyServer) {
    await closeServer(googleAiProxyServer);
  }
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
  if (stop.stopped) {
    throw new Error("Relay stop requested before gateway startup completed");
  }
  await gateway.start();
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

