import "dotenv/config";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { loadRelayConfig, type RelayConfig } from "./config/env.js";
import { isCodexModelRef, readOpenclawPrimaryModelRef, resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { PushServerHttpError, startPushServer } from "./push/pushServer.js";
import { InMemoryTaskQueue, QueueClosedError, QueueFullError } from "./queue/inMemoryTaskQueue.js";
import { createMessageProcessor, createRelayTaskControl } from "./processor/messageProcessor.js";
import { createDevicePairingAutoApprover } from "./openclaw/devicePairingAutoApprover.js";
import { createExecApprovalAutoApprover } from "./openclaw/execApprovalAutoApprover.js";
import {
  LOCAL_PROXY_LISTEN_HOST,
  startElevenlabsProxyServer,
  startFalProxyServer,
  startOpenAiProxyServer,
  startGoogleAiProxyServer,
  startJinaProxyServer,
  startMoonshotProxyServer,
  startOpenRouterProxyServer,
  startRunwayProxyServer,
} from "./openrouter/proxyServer.js";
import { createGatewayEventForwarder } from "./openclaw/gatewayEventForwarder.js";
import { createOpenclawConnectionStatusReporter } from "./openclaw/connectionStatusReporter.js";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./relayChannel/startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./relayChannel/startControlPlaneServer.js";
import { createRelayChannelTransportDeliveryTracker } from "./relayChannel/transportDeliveryTracker.js";
import { ensureRelayChannelPluginUpToDate } from "./relayChannel/ensurePluginUpToDate.js";
import { abortActiveChatTaskByBackendMessageId } from "./agentControl/abortActiveChatTask.js";
import { executeAgentControl } from "./agentControl/executeAgentControl.js";

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
      openaiProxyEnabled: cfg.openaiProxy.enabled,
      openaiProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      openaiProxyPort: cfg.openaiProxy.port,
      openaiProxyPathPrefix: cfg.openaiProxy.pathPrefix,
      jinaProxyEnabled: cfg.jinaProxy.enabled,
      jinaProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      jinaProxyPort: cfg.jinaProxy.port,
      jinaProxyPathPrefix: cfg.jinaProxy.pathPrefix,
      googleAiProxyEnabled: cfg.googleAiProxy.enabled,
      googleAiProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      googleAiProxyPort: cfg.googleAiProxy.port,
      googleAiProxyPathPrefix: cfg.googleAiProxy.pathPrefix,
      elevenlabsProxyEnabled: cfg.elevenlabsProxy.enabled,
      elevenlabsProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      elevenlabsProxyPort: cfg.elevenlabsProxy.port,
      elevenlabsProxyPathPrefix: cfg.elevenlabsProxy.pathPrefix,
      falProxyEnabled: cfg.falProxy.enabled,
      falProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      falProxyPort: cfg.falProxy.port,
      falProxyPathPrefix: cfg.falProxy.pathPrefix,
      runwayProxyEnabled: cfg.runwayProxy.enabled,
      runwayProxyListenHost: LOCAL_PROXY_LISTEN_HOST,
      runwayProxyPort: cfg.runwayProxy.port,
      runwayProxyPathPrefix: cfg.runwayProxy.pathPrefix,
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
      relayChannelPluginAutoUpdateEnabled: cfg.relayChannel.plugin.autoUpdateEnabled,
      relayChannelPluginGitRef: cfg.relayChannel.plugin.gitRef,
      relayChannelPluginRepoDir: cfg.relayChannel.plugin.repoDir,
    },
    "Relay starting"
  );

  if (cfg.relayChannel.enabled) {
    await ensureRelayChannelPluginUpToDate({
      openclawConfigPath: openclaw.configPath,
      plugin: cfg.relayChannel.plugin,
    });
  }

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
  const transportDeliveryTracker = createRelayChannelTransportDeliveryTracker();
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
      transportDeliveryTracker,
      executeAgentControl: (action) =>
        executeAgentControl({
          action,
          configPath: openclaw.configPath,
          gateway: gateway ?? {
            request: () => {
              throw new Error("Gateway is not initialized");
            },
          },
          backend,
          relayInstanceId: cfg.relayInstanceId,
          statusNudgeRunner: chatRunner ?? undefined,
        }),
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
      chatRunner?.handleGatewayConnectionStateChange(state);
      void reportOpenclawConnectionStatus(state);
    },
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    devLogGatewayFrames: cfg.devLogGatewayFrames,
    tickTimeoutMultiplier: cfg.openclaw.tickTimeoutMultiplier,
  });
  devicePairingAutoApprover = createDevicePairingAutoApprover({ gateway });
  devicePairingAutoApprover.start();
  execApprovalAutoApprover = createExecApprovalAutoApprover({ gateway });
  execApprovalAutoApprover.start();
  chatRunner = new ChatRunner(gateway, {
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    onRunCompleted: (runId, reason) => {
      forwardGatewayEvent.closeRun(runId, reason);
    },
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
  const taskControl = createRelayTaskControl();
  const processOne = createMessageProcessor({
    cfg: {
      relayInstanceId: cfg.relayInstanceId,
      taskTimeoutMs: cfg.taskTimeoutMs,
      systemTaskTimeoutMs: cfg.systemTaskTimeoutMs,
      chatBatchDebounceMs: cfg.chatBatchDebounceMs,
      lowDiskAlertEnabled: cfg.lowDiskAlertEnabled,
      lowDiskAlertThresholdPercent: cfg.lowDiskAlertThresholdPercent,
      devLogEnabled: cfg.devLogEnabled,
      devLogTextMaxLen: cfg.devLogTextMaxLen,
    },
    gateway,
    runner,
    backend,
    taskControl,
    transportDeliveryTracker,
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
      const activeTasks = taskControl.getActiveTasks();
      const now = Date.now();
      const oldestActiveTask =
        activeTasks.length > 0
          ? activeTasks.reduce((oldest, task) => (task.startedAtMs < oldest.startedAtMs ? task : oldest))
          : null;
      const activeTaskAgeMs = oldestActiveTask ? now - oldestActiveTask.startedAtMs : null;
      return {
        ok: true,
        ready: !shuttingDown && gateway.isReady() && queueState.queueLength < queueState.maxQueue,
        details: {
          shuttingDown,
          gatewayReady: gateway.isReady(),
          queueLength: queueState.queueLength,
          inFlight: queueState.inFlight,
          activeTaskCount: activeTasks.length,
          activeTaskAgeMs,
          activeTaskMessageId: oldestActiveTask?.messageId ?? null,
          activeTaskKind: oldestActiveTask?.taskKind ?? null,
          activeTaskSessionKey: oldestActiveTask?.sessionKey ?? null,
          activeTasks,
          maxQueue: queueState.maxQueue,
          backendResilience,
          relayChannel: getRelayChannelHealth(),
        },
      };
    },
    onMessage: (message) => {
      try {
        if (message.input.kind === "chat" && isUserChatMessage(message)) {
          const sessionKey = message.input.sessionKey;
          const removedSystemReminders = queue.removeQueued(
            (queued) =>
              queued.input.kind === "chat" &&
              queued.input.sessionKey === sessionKey &&
              isSystemReminderMessage(queued)
          );
          for (const queued of removedSystemReminders) {
            void submitDroppedSystemReminder({
              backend,
              relayInstanceId: cfg.relayInstanceId,
              message: queued,
              reason: "dropped_for_newer_user_message",
            });
          }
          const removedUserChats = queue.removeQueued(
            (queued) =>
              queued.input.kind === "chat" &&
              queued.input.sessionKey === sessionKey &&
              isUserChatMessage(queued) &&
              queued.messageId !== message.messageId
          );
          for (const queued of removedUserChats) {
            void submitDroppedSupersededUserChat({
              backend,
              relayInstanceId: cfg.relayInstanceId,
              message: queued,
              reason: "superseded_by_newer_user_message",
            });
          }
          const abortedSystemReminder = taskControl.abortActive(
            (task) => task.taskKind === "system_reminder" && task.sessionKey === sessionKey,
            "newer_user_message"
          );
          if (abortedSystemReminder) {
            logger.warn(
              {
                event: "relay_queue",
                stage: "active_system_task_preempted",
                backendMessageId: message.messageId,
                sessionKey,
              },
              "Preempted active system reminder for newer user message"
            );
          }
          const abortedUserChat = taskControl.abortActive(
            (task) => task.taskKind === "user_chat" && task.sessionKey === sessionKey,
            "newer_user_message"
          );
          if (abortedUserChat) {
            logger.warn(
              {
                event: "relay_queue",
                stage: "active_user_task_preempted",
                backendMessageId: message.messageId,
                sessionKey,
              },
              "Preempted active user chat for newer user message"
            );
          }
        }
        queue.enqueue(message);
        const queueState = queue.getState();
        logger.info(
          {
            event: "relay_queue",
            stage: "enqueued",
            backendMessageId: message.messageId,
            kind: message.input.kind,
            sessionKey: message.input.kind === "chat" ? message.input.sessionKey : null,
            queueLength: queueState.queueLength,
            inFlight: queueState.inFlight,
            maxQueue: queueState.maxQueue,
          },
          "Relay message enqueued"
        );
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
    onAgentControl: async (message) => {
      if (message.input.kind !== "agent_control") {
        throw new Error("agent_control payload expected");
      }
      if (message.input.action.kind === "chat.abortTask") {
        const { aborted } = await abortActiveChatTaskByBackendMessageId({
          taskControl,
          runner,
          backendMessageId: message.input.action.backendMessageId,
          reason: message.input.action.reason ?? "backend_abort",
        });
        return { kind: "chat.abortTask", aborted };
      }
      return executeAgentControl({
        action: message.input.action,
        configPath: openclaw.configPath,
        gateway,
        backend,
        relayInstanceId: cfg.relayInstanceId,
        backendMessageId: message.messageId,
        statusNudgeRunner: runner,
      });
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
  const openaiProxyServer = cfg.openaiProxy.enabled
    ? startOpenAiProxyServer({
        port: cfg.openaiProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.openaiProxy.pathPrefix,
        backendPathPrefix: cfg.openaiProxy.backendPathPrefix,
        shouldProxyWebSocketUpgrade: () => {
          const activeModelRef = readOpenclawPrimaryModelRef(openclaw.configPath);
          if (isCodexModelRef(activeModelRef)) {
            return Promise.resolve({ allowed: true as const });
          }
          logger.info(
            {
              activeModelRef,
              openclawConfigPath: openclaw.configPath,
            },
            "Rejecting OpenAI websocket proxy upgrade because the active model is not codex/*"
          );
          return Promise.resolve({
            allowed: false as const,
            statusCode: 403,
            message: "OpenAI websocket proxy is only available for active codex/* models",
          });
        },
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
  const elevenlabsProxyServer = cfg.elevenlabsProxy.enabled
    ? startElevenlabsProxyServer({
        port: cfg.elevenlabsProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.elevenlabsProxy.pathPrefix,
        backendPathPrefix: cfg.elevenlabsProxy.backendPathPrefix,
      })
    : null;
  const falProxyServer = cfg.falProxy.enabled
    ? startFalProxyServer({
        port: cfg.falProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.falProxy.pathPrefix,
        backendPathPrefix: cfg.falProxy.backendPathPrefix,
      })
    : null;
  const runwayProxyServer = cfg.runwayProxy.enabled
    ? startRunwayProxyServer({
        port: cfg.runwayProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.runwayProxy.pathPrefix,
        backendPathPrefix: cfg.runwayProxy.backendPathPrefix,
      })
    : null;
  const moonshotProxyServer = cfg.moonshotProxy.enabled
    ? startMoonshotProxyServer({
        port: cfg.moonshotProxy.port,
        backendBaseUrl: cfg.backendBaseUrl,
        relayToken: cfg.relayToken,
        pathPrefix: cfg.moonshotProxy.pathPrefix,
        backendPathPrefix: cfg.moonshotProxy.backendPathPrefix,
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
  if (openaiProxyServer) {
    await closeServer(openaiProxyServer);
  }
  if (jinaProxyServer) {
    await closeServer(jinaProxyServer);
  }
  if (googleAiProxyServer) {
    await closeServer(googleAiProxyServer);
  }
  if (elevenlabsProxyServer) {
    await closeServer(elevenlabsProxyServer);
  }
  if (falProxyServer) {
    await closeServer(falProxyServer);
  }
  if (runwayProxyServer) {
    await closeServer(runwayProxyServer);
  }
  if (moonshotProxyServer) {
    await closeServer(moonshotProxyServer);
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

type ChatPushMessage = InboundPushMessage & { input: Extract<InboundPushMessage["input"], { kind: "chat" }> };

function isUserChatMessage(message: InboundPushMessage): message is ChatPushMessage {
  return message.input.kind === "chat" && !isSystemReminderMessage(message);
}

function isSystemReminderMessage(message: InboundPushMessage): message is ChatPushMessage {
  if (message.input.kind !== "chat") {
    return false;
  }
  const context = message.input.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return false;
  }
  const kind = (context as { kind?: unknown }).kind;
  return kind === "relay_stale_timeout_reminder" || kind === "relay_status_nudge";
}

async function submitDroppedSupersededUserChat(input: {
  backend: BackendClient;
  relayInstanceId: string;
  message: InboundPushMessage;
  reason: string;
}): Promise<void> {
  const relayMessageId = `relay_drop_${randomUUID()}`;
  try {
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId,
        finishedAtMs: Date.now(),
        outcome: "error",
        error: {
          code: "RELAY_TASK_SUPERSEDED",
          message: `Relay task was superseded: ${input.reason}`,
        },
        openclawMeta: {
          method: "relay_queue",
          trace: {
            backendMessageId: input.message.messageId,
            relayMessageId,
            relayInstanceId: input.relayInstanceId,
          },
          ...(input.message.input.kind === "chat" ? { sessionKey: input.message.input.sessionKey } : {}),
        },
      },
    });
  } catch (error) {
    logger.warn(
      {
        event: "relay_queue",
        stage: "dropped_user_task_callback_failed",
        backendMessageId: input.message.messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to submit dropped user chat callback"
    );
  }
}

async function submitDroppedSystemReminder(input: {
  backend: BackendClient;
  relayInstanceId: string;
  message: InboundPushMessage;
  reason: string;
}): Promise<void> {
  const relayMessageId = `relay_drop_${randomUUID()}`;
  try {
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.relayInstanceId,
        relayMessageId,
        finishedAtMs: Date.now(),
        outcome: "no_reply",
        noReply: { reason: input.reason },
        openclawMeta: {
          method: "relay_queue",
          trace: {
            backendMessageId: input.message.messageId,
            relayMessageId,
            relayInstanceId: input.relayInstanceId,
          },
          ...(input.message.input.kind === "chat" ? { sessionKey: input.message.input.sessionKey } : {}),
        },
      },
    });
  } catch (error) {
    logger.warn(
      {
        event: "relay_queue",
        stage: "dropped_system_task_callback_failed",
        backendMessageId: input.message.messageId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to submit dropped system reminder callback"
    );
  }
}

function buildRelayDeliveryReportForBackend(
  cfg: RelayConfig,
  getHealth: () => Record<string, unknown>
): Record<string, unknown> {
  if (!cfg.relayChannel.enabled) {
    return {
      modeEffective: "relay_channel_v2",
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
      modeEffective: "relay_channel_v2",
      relayChannelReady: false,
      relayChannelConnected: false,
    };
  }
  const cp = h.controlPlane;
  return {
    modeEffective: "relay_channel_v2",
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

