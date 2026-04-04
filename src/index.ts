import "dotenv/config";
import { logger } from "./logger.js";
import { loadRelayConfig, type RelayConfig } from "./config/env.js";
import { resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { PushServerHttpError, startPushServer } from "./push/pushServer.js";
import { InMemoryTaskQueue, QueueClosedError, QueueFullError } from "./queue/inMemoryTaskQueue.js";
import { createMessageProcessor } from "./processor/messageProcessor.js";
import { createDevicePairingAutoApprover } from "./openclaw/devicePairingAutoApprover.js";
import { createExecApprovalAutoApprover } from "./openclaw/execApprovalAutoApprover.js";
import {
  LOCAL_PROXY_LISTEN_HOST,
  startGoogleAiProxyServer,
  startJinaProxyServer,
  startOpenRouterProxyServer,
} from "./openrouter/proxyServer.js";
import { createGatewayEventForwarder } from "./openclaw/gatewayEventForwarder.js";
import { createOpenclawConnectionStatusReporter } from "./openclaw/connectionStatusReporter.js";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./relayChannel/startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./relayChannel/startControlPlaneServer.js";

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
      jinaProxyEnabled: cfg.jinaProxy.enabled,
      jinaProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      jinaProxyPort: cfg.jinaProxy.port,
      jinaProxyPathPrefix: cfg.jinaProxy.pathPrefix,
      googleAiProxyEnabled: cfg.googleAiProxy.enabled,
      googleAiProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      googleAiProxyPort: cfg.googleAiProxy.port,
      googleAiProxyPathPrefix: cfg.googleAiProxy.pathPrefix,
      pushRateLimitPerSecond: cfg.pushRateLimitPerSecond,
      pushMaxConcurrentRequests: cfg.pushMaxConcurrentRequests,
      pushMaxQueue: cfg.pushMaxQueue,
      relayChannelEnabled: cfg.relayChannel.enabled,
      relayChannelControlPlane: cfg.relayChannel.enabled
        ? `${cfg.relayChannel.controlPlaneHost}:${cfg.relayChannel.controlPlanePort}`
        : null,
      relayChannelDataPlane: cfg.relayChannel.enabled
        ? `${cfg.relayChannel.dataPlaneHost}:${cfg.relayChannel.dataPlanePort}`
        : null,
    },
    "Relay starting"
  );

  const backend = new BackendClient({
    baseUrl: cfg.backendBaseUrl,
    relayToken: cfg.relayToken,
    devLogEnabled: cfg.devLogEnabled,
  });

  let gateway: GatewayClient | null = null;
  let reportOpenclawConnectionStatus:
    | ReturnType<typeof createOpenclawConnectionStatusReporter>
    | null = null;
  let getRelayChannelHealth: () => Record<string, unknown> = () => ({ enabled: false });
  let relayChannelCleanup: (() => Promise<void>) | null = null;
  let publishRelayChannelEvent: ((event: Record<string, unknown>) => void) | null = null;
  if (cfg.relayChannel.enabled) {
    const dp = startRelayChannelDataPlaneServer({
      host: cfg.relayChannel.dataPlaneHost,
      port: cfg.relayChannel.dataPlanePort,
    });
    const cp = startRelayChannelControlPlane({
      host: cfg.relayChannel.controlPlaneHost,
      port: cfg.relayChannel.controlPlanePort,
      relayInstanceId: cfg.relayInstanceId,
      backend,
      getDataPlane: () => {
        const s = dp.getState();
        return {
          uploadBaseUrl: s.uploadBaseUrl,
          downloadBaseUrl: s.downloadBaseUrl,
          registerDownload: dp.registerDownload,
        };
      },
      onStateChange: (state) => {
        if (!reportOpenclawConnectionStatus) return;
        void reportOpenclawConnectionStatus({
          connected: gateway?.isReady() ?? false,
          observedAtMs: Date.now(),
          reason: state.clientConnected ? undefined : "Relay-channel control plane disconnected",
        });
      },
    });
    publishRelayChannelEvent = cp.publishEvent;
    getRelayChannelHealth = () => ({
      enabled: true,
      controlPlane: cp.getState(),
      dataPlane: {
        host: cfg.relayChannel.dataPlaneHost,
        port: cfg.relayChannel.dataPlanePort,
        listening: dp.getState().listening,
      },
    });
    relayChannelCleanup = async () => {
      await cp.close();
      await closeHttpServer(dp.server);
    };
  }

  reportOpenclawConnectionStatus = createOpenclawConnectionStatusReporter({
    backend,
    relayInstanceId: cfg.relayInstanceId,
    buildDeliveryReport: () => buildRelayDeliveryReportForBackend(cfg, getRelayChannelHealth),
  });

  let chatRunner: ChatRunner | null = null;
  const forwardGatewayEvent = createGatewayEventForwarder({
    relayInstanceId: cfg.relayInstanceId,
    backend,
    forwardFinalOnly: cfg.openclawForwardFinalOnly,
    getChatRunTrace: (runId) => chatRunner?.getRunTrace(runId) ?? null,
  });
  let devicePairingAutoApprover:
    | ReturnType<typeof createDevicePairingAutoApprover>
    | null = null;
  let execApprovalAutoApprover:
    | ReturnType<typeof createExecApprovalAutoApprover>
    | null = null;

  gateway = new GatewayClient({
    url: openclaw.gateway.wsUrl,
    token: openclaw.gateway.auth.token,
    password: openclaw.gateway.auth.password,
    instanceId: cfg.relayInstanceId,
    role: "operator",
    scopes: cfg.openclaw.scopes,
    onEvent: (evt) => {
      devicePairingAutoApprover?.handleEvent(evt);
      execApprovalAutoApprover?.handleEvent(evt);
      chatRunner?.handleEvent(evt);
      void forwardGatewayEvent(evt);
    },
    onHelloOk: (hello) => {
      devicePairingAutoApprover?.handleHello(hello);
      execApprovalAutoApprover?.handleHello(hello);
    },
    onConnectionStateChange: (state) => {
      void reportOpenclawConnectionStatus(state);
    },
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    devLogGatewayFrames: cfg.devLogGatewayFrames,
  });
  devicePairingAutoApprover = createDevicePairingAutoApprover({ gateway });
  devicePairingAutoApprover.start();
  execApprovalAutoApprover = createExecApprovalAutoApprover({ gateway });
  execApprovalAutoApprover.start();
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
      lowDiskAlertEnabled: cfg.lowDiskAlertEnabled,
      lowDiskAlertThresholdPercent: cfg.lowDiskAlertThresholdPercent,
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
          relayChannel: getRelayChannelHealth(),
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
    onTransportEvent: (message) => {
      if (!publishRelayChannelEvent) {
        throw new PushServerHttpError({
          statusCode: 503,
          code: "RELAY_CHANNEL_DISABLED",
          message: "Relay channel control plane is disabled",
        });
      }
      if (message.input.kind !== "transport_event") {
        throw new PushServerHttpError({
          statusCode: 400,
          code: "TRANSPORT_EVENT_EXPECTED",
          message: "Push payload did not contain a transport event",
        });
      }
      publishRelayChannelEvent(message.input.event);
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
  const jinaProxyServer = cfg.jinaProxy.enabled
    ? startJinaProxyServer({
        port: cfg.jinaProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.jinaProxy.pathPrefix,
        backendPathPrefix: cfg.jinaProxy.backendPathPrefix,
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
  if (jinaProxyServer) {
    await closeServer(jinaProxyServer);
  }
  if (googleAiProxyServer) {
    await closeServer(googleAiProxyServer);
  }
  if (relayChannelCleanup) {
    await relayChannelCleanup();
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
  devicePairingAutoApprover.stop();
  execApprovalAutoApprover.stop();
  logger.info("Relay stopped");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Relay crashed");
  process.exit(1);
});

function buildRelayDeliveryReportForBackend(
  cfg: RelayConfig,
  getHealth: () => Record<string, unknown>
): Record<string, unknown> {
  if (!cfg.relayChannel.enabled) {
    return {
      modeEffective: "legacy_push_v1",
      legacyPushReady: true,
      relayChannelReady: false,
      relayChannelConnected: false,
    };
  }
  const h = getHealth() as {
    enabled?: boolean;
    controlPlane?: {
      listening?: boolean;
      clientConnected?: boolean;
    };
  };
  if (!h.enabled) {
    return {
      modeEffective: "legacy_push_v1",
      legacyPushReady: true,
      relayChannelReady: false,
      relayChannelConnected: false,
    };
  }
  const cp = h.controlPlane;
  return {
    modeEffective: "relay_channel_v2",
    legacyPushReady: true,
    relayChannelReady: Boolean(cp?.listening),
    relayChannelConnected: Boolean(cp?.clientConnected),
    relayChannelLastError: null,
  };
}

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

