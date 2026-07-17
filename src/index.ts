import "dotenv/config";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import { loadRelayConfig, type RelayConfig } from "./config/env.js";
import {
  isCodexModelRef,
  readOpenclawPrimaryModelRef,
  resolveOpenclawConfig,
} from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { type InboundPushMessage } from "./backend/types.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";
import { transcribeAudioWithOpenAi } from "./openclaw/openaiTranscription.js";
import { PushServerHttpError, startPushServer } from "./push/pushServer.js";
import {
  InMemoryTaskQueue,
  QueueClosedError,
  QueueFullError,
} from "./queue/inMemoryTaskQueue.js";
import {
  createMessageProcessor,
  createRelayTaskControl,
  reconcileDurableInFlightChatTasks,
} from "./processor/messageProcessor.js";
import { createInFlightTaskStore } from "./processor/inFlightTaskStore.js";
import { createDevicePairingAutoApprover } from "./openclaw/devicePairingAutoApprover.js";
import { createNodePairingAutoApprover } from "./openclaw/nodePairingAutoApprover.js";
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
import {
  buildFinalDecisionNoticeText,
  buildNudgeDecisionNoticeText,
  createSelfNudgeRunner,
  findVisibleFinalityInOpenclawRuntimeHistory,
  isOpenclawRuntimeIdle,
} from "./openclaw/selfNudgeRunner.js";
import { createOpenclawConnectionStatusReporter } from "./openclaw/connectionStatusReporter.js";
import {
  closeHttpServer,
  startRelayChannelDataPlaneServer,
} from "./relayChannel/startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./relayChannel/startControlPlaneServer.js";
import { createRelayChannelTransportDeliveryTracker } from "./relayChannel/transportDeliveryTracker.js";
import { abortActiveChatTaskByBackendMessageId } from "./agentControl/abortActiveChatTask.js";
import { executeAgentControl } from "./agentControl/executeAgentControl.js";
import {
  createConversationActivityIndex,
  inferConversationChannel,
  inferTransportTarget,
} from "./conversation/activityIndex.js";
import { deliverSystemNotificationFromRelay } from "./conversation/systemNotificationDelivery.js";
import { createRelayDiagnosticNotifier } from "./diagnostics/errorDiagnostics.js";

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
      relayChannelPluginAutoUpdateEnabled:
        cfg.relayChannel.plugin.autoUpdateEnabled,
      relayChannelPluginGitRef: cfg.relayChannel.plugin.gitRef,
      relayChannelPluginRepoDir: cfg.relayChannel.plugin.repoDir,
      diagnosticNotifierEnabled: cfg.diagnosticNotifier.enabled,
    },
    "Relay starting",
  );

  const backend = new BackendClient({
    baseUrl: cfg.backendBaseUrl,
    relayToken: cfg.relayToken,
    devLogEnabled: cfg.devLogEnabled,
  });
  const inFlightTaskStore = createInFlightTaskStore();
  const activityIndex = createConversationActivityIndex();
  await activityIndex.load();

  let gateway: GatewayClient | null = null;
  let reportOpenclawConnectionStatus: ReturnType<
    typeof createOpenclawConnectionStatusReporter
  > | null = null;
  let getRelayChannelHealth: () => Record<string, unknown> = () => ({
    enabled: false,
  });
  let relayChannelCleanup: (() => Promise<void>) | null = null;
  let publishRelayChannelEvent:
    | ((event: Record<string, unknown>) => void)
    | null = null;
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
          reason: state.clientConnected
            ? undefined
            : "Relay-channel control plane disconnected",
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
    buildDeliveryReport: () =>
      buildRelayDeliveryReportForBackend(cfg, getRelayChannelHealth),
  });

  let chatRunner: ChatRunner | null = null;
  const forwardGatewayEvent = createGatewayEventForwarder({
    relayInstanceId: cfg.relayInstanceId,
    backend,
    forwardFinalOnly: cfg.openclawForwardFinalOnly,
    getChatRunTrace: (runId) => chatRunner?.getRunTrace(runId) ?? null,
    onChatActivity: async ({ sessionKey, userFacingText, atMs }) => {
      const channel = inferConversationChannel(sessionKey);
      if (channel !== "telegram" && channel !== "whatsapp_personal") {
        return;
      }
      await activityIndex.recordOutbound({
        sessionKey,
        channel,
        transportTarget: inferTransportTarget({ sessionKey, channel }),
        serverId: readServerIdFromTransportSessionKey(sessionKey),
        text: userFacingText ?? undefined,
        at: atMs,
      });
    },
  });
  let devicePairingAutoApprover: ReturnType<
    typeof createDevicePairingAutoApprover
  > | null = null;
  let nodePairingAutoApprover: ReturnType<
    typeof createNodePairingAutoApprover
  > | null = null;
  let execApprovalAutoApprover: ReturnType<
    typeof createExecApprovalAutoApprover
  > | null = null;

  gateway = new GatewayClient({
    url: openclaw.gateway.wsUrl,
    token: openclaw.gateway.auth.token,
    password: openclaw.gateway.auth.password,
    instanceId: cfg.relayInstanceId,
    role: "operator",
    scopes: cfg.openclaw.scopes,
    onEvent: (evt) => {
      devicePairingAutoApprover?.handleEvent(evt);
      nodePairingAutoApprover?.handleEvent(evt);
      execApprovalAutoApprover?.handleEvent(evt);
      chatRunner?.handleEvent(evt);
      void forwardGatewayEvent(evt);
    },
    onHelloOk: (hello) => {
      devicePairingAutoApprover?.handleHello(hello);
      nodePairingAutoApprover?.handleHello(hello);
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
  nodePairingAutoApprover = createNodePairingAutoApprover({ gateway });
  nodePairingAutoApprover.start();
  execApprovalAutoApprover = createExecApprovalAutoApprover({ gateway });
  execApprovalAutoApprover.start();
  chatRunner = new ChatRunner(gateway, {
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    onRunCompleted: (runId, reason) => {
      forwardGatewayEvent.closeRun(runId, reason);
    },
    onRunStarted: async ({ taskId, runId, requestMessage }) => {
      await inFlightTaskStore
        .updateRun({
          backendMessageId: taskId,
          runId,
          requestMessage,
          updatedAtMs: Date.now(),
        })
        .catch((error) => {
          logger.warn(
            {
              event: "relay_restart_recovery",
              stage: "record_run_failed",
              backendMessageId: taskId,
              openclawRunId: runId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to durably record in-flight OpenClaw run",
          );
        });
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
      selfNudgeTaskTimeoutMs: cfg.selfNudgeTaskTimeoutMs,
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
    inFlightTaskStore,
    activityIndex,
  });

  void reconcileDurableInFlightChatTasks({
    cfg: {
      relayInstanceId: cfg.relayInstanceId,
      restartRecoveryTimeoutMs: 30_000,
    },
    runner,
    backend,
    inFlightTaskStore,
    transportDeliveryTracker,
    activityIndex,
  }).catch((error) => {
    logger.warn(
      {
        event: "relay_restart_recovery",
        stage: "reconcile_failed",
        error: error instanceof Error ? error.message : String(error),
      },
      "Relay restart recovery failed",
    );
  });

  const queue = new InMemoryTaskQueue<InboundPushMessage>({
    concurrency: cfg.concurrency,
    maxQueue: cfg.pushMaxQueue,
    processor: processOne,
  });
  const preemptSessionForUserOwnedTurn = (input: {
    message: ChatPushMessage;
    reason: string;
    dropQueuedUserChats: boolean;
  }) => {
    const { message, reason, dropQueuedUserChats } = input;
    const sessionKey = message.input.sessionKey;
    const removedSystemReminders = queue.removeQueued(
      (queued) =>
        queued.input.kind === "chat" &&
        queued.input.sessionKey === sessionKey &&
        isSystemReminderMessage(queued) &&
        queued.messageId !== message.messageId,
    );
    for (const queued of removedSystemReminders) {
      void submitDroppedSystemReminder({
        backend,
        relayInstanceId: cfg.relayInstanceId,
        message: queued,
        reason,
      });
    }
    if (dropQueuedUserChats) {
      const removedUserChats = queue.removeQueued(
        (queued) =>
          queued.input.kind === "chat" &&
          queued.input.sessionKey === sessionKey &&
          isUserChatMessage(queued) &&
          queued.messageId !== message.messageId,
      );
      for (const queued of removedUserChats) {
        void submitDroppedSupersededUserChat({
          backend,
          relayInstanceId: cfg.relayInstanceId,
          message: queued,
          reason: "superseded_by_newer_user_message",
        });
      }
    }
    const abortedSystemReminder = taskControl.abortActive(
      (task) =>
        (task.taskKind === "system_reminder" ||
          task.taskKind === "status_nudge") &&
        task.sessionKey === sessionKey,
      reason,
    );
    if (abortedSystemReminder) {
      logger.warn(
        {
          event: "relay_queue",
          stage: "active_system_task_preempted",
          backendMessageId: message.messageId,
          sessionKey,
          reason,
        },
        "Preempted active system task for newer user-owned turn",
      );
    }
    const abortedUserChat = taskControl.abortActive(
      (task) => task.taskKind === "user_chat" && task.sessionKey === sessionKey,
      reason,
    );
    if (abortedUserChat) {
      logger.warn(
        {
          event: "relay_queue",
          stage: "active_user_task_preempted",
          backendMessageId: message.messageId,
          sessionKey,
          reason,
        },
        "Preempted active user chat for newer user-owned turn",
      );
    }
  };

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
          ? activeTasks.reduce((oldest, task) =>
              task.startedAtMs < oldest.startedAtMs ? task : oldest,
            )
          : null;
      const activeTaskAgeMs = oldestActiveTask
        ? now - oldestActiveTask.startedAtMs
        : null;
      return {
        ok: true,
        ready:
          !shuttingDown &&
          gateway.isReady() &&
          queueState.queueLength < queueState.maxQueue,
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
          void activityIndex
            .recordInbound({
              sessionKey,
              text: message.input.messageText,
              context: message.input.context,
              at: message.sentAtMs ?? Date.now(),
            })
            .catch((error) => {
              logger.warn(
                {
                  event: "conversation_activity",
                  stage: "record_inbound_failed",
                  backendMessageId: message.messageId,
                  sessionKey,
                  error: error instanceof Error ? error.message : String(error),
                },
                "Failed to record conversation inbound activity",
              );
            });
          preemptSessionForUserOwnedTurn({
            message,
            reason: "newer_user_message",
            dropQueuedUserChats: true,
          });
        }
        queue.enqueue(message);
        const queueState = queue.getState();
        logger.info(
          {
            event: "relay_queue",
            stage: "enqueued",
            backendMessageId: message.messageId,
            kind: message.input.kind,
            sessionKey:
              message.input.kind === "chat" ? message.input.sessionKey : null,
            queueLength: queueState.queueLength,
            inFlight: queueState.inFlight,
            maxQueue: queueState.maxQueue,
          },
          "Relay message enqueued",
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
      void recordTransportEventActivity({
        activityIndex,
        message,
      });
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
    onSystemNotification: (message) =>
      deliverSystemNotificationFromRelay({
        backend,
        activityIndex,
        message,
        gateway,
      }),
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
          const activeModelRef = readOpenclawPrimaryModelRef(
            openclaw.configPath,
          );
          if (isCodexModelRef(activeModelRef)) {
            return Promise.resolve({ allowed: true as const });
          }
          logger.info(
            {
              activeModelRef,
              openclawConfigPath: openclaw.configPath,
            },
            "Rejecting OpenAI websocket proxy upgrade because the active model is not codex/*",
          );
          return Promise.resolve({
            allowed: false as const,
            statusCode: 403,
            message:
              "OpenAI websocket proxy is only available for active codex/* models",
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
  const selfNudgeRunner =
    cfg.relayChannel.enabled && cfg.openrouterProxy.enabled
      ? createSelfNudgeRunner({
          settings: cfg.selfNudge,
          gateway,
          openrouterProxyPort: cfg.openrouterProxy.port,
          openrouterProxyPathPrefix: cfg.openrouterProxy.pathPrefix,
          isLocallyIdle: () => {
            const queueState = queue.getState();
            return (
              queueState.queueLength === 0 &&
              queueState.inFlight === 0 &&
              taskControl.getActiveTasks().length === 0
            );
          },
          confirmIdle: async () => {
            const before = queue.getState();
            if (
              before.queueLength > 0 ||
              before.inFlight > 0 ||
              taskControl.getActiveTasks().length > 0
            ) {
              return false;
            }
            const runtimeIdle = await isOpenclawRuntimeIdle({ gateway });
            const after = queue.getState();
            return (
              runtimeIdle &&
              after.queueLength === 0 &&
              after.inFlight === 0 &&
              taskControl.getActiveTasks().length === 0
            );
          },
          sendNudgeMessage: ({
            transcript,
            decision,
            messageText,
            taskId,
            nowMs,
          }) => {
            const route =
              activityIndex
                .snapshot()
                .find(
                  (record) => record.sessionKey === transcript.sessionKey,
                ) ?? activityIndex.findBestUserVisibleRoute({ now: nowMs });
            const message: ChatPushMessage = {
              messageId: taskId,
              sentAtMs: nowMs,
              input: {
                kind: "chat",
                sessionKey: transcript.sessionKey,
                messageText,
                context: {
                  kind: "relay_status_nudge",
                  source: "relay.self_nudge",
                  relayInstanceId: cfg.relayInstanceId,
                  sessionKey: transcript.sessionKey,
                  routeSessionKey: route?.sessionKey ?? transcript.sessionKey,
                  channel:
                    route?.channel ??
                    inferConversationChannel(transcript.sessionKey),
                  transportTarget:
                    route?.transportTarget ??
                    inferTransportTarget({
                      sessionKey: transcript.sessionKey,
                      channel: route?.channel,
                    }),
                  finalConfidence: decision.finalConfidence,
                  reasonCode: decision.reasonCode ?? null,
                  reason: decision.reason ?? null,
                },
              },
            };
            queue.enqueue(message);
            const queueState = queue.getState();
            logger.info(
              {
                event: "relay_self_nudge",
                stage: "enqueued_user_owned_turn",
                backendMessageId: taskId,
                sessionKey: transcript.sessionKey,
                routeSessionKey: route?.sessionKey ?? transcript.sessionKey,
                queueLength: queueState.queueLength,
                inFlight: queueState.inFlight,
              },
              "Relay self-nudge enqueued a user-owned conversation turn",
            );
            return Promise.resolve();
          },
          findVisibleFinality: async ({ transcript }) => {
            const route =
              activityIndex
                .snapshot()
                .find(
                  (record) => record.sessionKey === transcript.sessionKey,
                ) ?? activityIndex.findBestUserVisibleRoute();
            const finality = route
              ? activityIndex.findLatestVisibleFinality({
                  sessionKey: route.sessionKey,
                  afterMs: transcript.latestUserMessage?.timestampMs,
                })
              : null;
            return finality
              ? {
                  visibleText: finality.visibleText ?? finality.mediaSummary,
                  deliveredAtMs: finality.deliveredAt,
                  deliveryKind:
                    finality.deliveryKind === "final" ||
                    finality.deliveryKind === "terminal_error" ||
                    finality.deliveryKind === "terminal_no_reply"
                      ? finality.deliveryKind
                      : undefined,
                }
              : await findVisibleFinalityInOpenclawRuntimeHistory({
                  gateway,
                  sessionKey: transcript.sessionKey,
                  afterMs: transcript.latestUserMessage?.timestampMs,
                });
          },
          notifyNudgeDecision: cfg.selfNudge.nudgeNoticeEnabled
            ? async ({ transcript, decision, messageText, nowMs }) => {
                const route =
                  activityIndex
                    .snapshot()
                    .find(
                      (record) => record.sessionKey === transcript.sessionKey,
                    ) ?? activityIndex.findBestUserVisibleRoute({ now: nowMs });
                const userId = route?.userId ?? "relay-self-nudge-debug";
                const notificationId = `relay-self-nudge-debug:${cfg.relayInstanceId}:${randomUUID()}`;
                const message: InboundPushMessage = {
                  messageId: `system-notification:${notificationId}`,
                  sentAtMs: nowMs,
                  input: {
                    kind: "system_notification",
                    notificationId,
                    userId,
                    text: buildNudgeDecisionNoticeText({
                      transcript,
                      decision,
                      messageText,
                      nowMs,
                    }),
                    eventKey: "relay.self_nudge.status_nudge",
                    code: "relay:self_nudge:status_nudge",
                    severity: "info",
                    rawTaskResult: {
                      relayInstanceId: cfg.relayInstanceId,
                      sessionKey: transcript.sessionKey,
                      finalConfidence: decision.finalConfidence,
                      reasonCode: decision.reasonCode ?? null,
                      reason: decision.reason ?? null,
                    },
                  },
                };
                const result = await deliverSystemNotificationFromRelay({
                  backend,
                  activityIndex,
                  message,
                  gateway,
                });
                logger.info(
                  {
                    event: "relay_self_nudge_debug_notice",
                    status: result.status,
                    selectedChannel: result.selectedChannel,
                    sessionKey: result.sessionKey,
                    error: result.error,
                  },
                  "Relay self-nudge debug notice processed",
                );
              }
            : undefined,
          notifyFinalDecision: cfg.selfNudge.finalNoticeEnabled
            ? async ({ transcript, decision, nowMs, visibleFinality }) => {
                const route =
                  activityIndex
                    .snapshot()
                    .find(
                      (record) => record.sessionKey === transcript.sessionKey,
                    ) ?? activityIndex.findBestUserVisibleRoute({ now: nowMs });
                const userId = route?.userId ?? "relay-self-nudge-final";
                const notificationId = `relay-self-nudge-final:${cfg.relayInstanceId}:${randomUUID()}`;
                const message: InboundPushMessage = {
                  messageId: `system-notification:${notificationId}`,
                  sentAtMs: nowMs,
                  input: {
                    kind: "system_notification",
                    notificationId,
                    userId,
                    text: buildFinalDecisionNoticeText({
                      transcript,
                      decision,
                      nowMs,
                      visibleFinality,
                    }),
                    eventKey: "relay.self_nudge.final_answer",
                    code: "relay:self_nudge:final_answer",
                    severity: "info",
                    rawTaskResult: {
                      relayInstanceId: cfg.relayInstanceId,
                      sessionKey: transcript.sessionKey,
                      finalConfidence: decision.finalConfidence,
                      reasonCode: decision.reasonCode ?? null,
                      reason: decision.reason ?? null,
                    },
                  },
                };
                const result = await deliverSystemNotificationFromRelay({
                  backend,
                  activityIndex,
                  message,
                  gateway,
                });
                logger.info(
                  {
                    event: "relay_self_nudge_final_notice",
                    status: result.status,
                    selectedChannel: result.selectedChannel,
                    sessionKey: result.sessionKey,
                    error: result.error,
                  },
                  "Relay self-nudge final notice processed",
                );
              }
            : undefined,
        })
      : null;
  selfNudgeRunner?.start();
  const diagnosticNotifier = createRelayDiagnosticNotifier({
    settings: cfg.diagnosticNotifier,
    backend,
    activityIndex,
    relayInstanceId: cfg.relayInstanceId,
  });
  diagnosticNotifier.start();

  await waitForStop(stop);
  shuttingDown = true;
  diagnosticNotifier.stop();
  selfNudgeRunner?.stop();
  queue.stopAccepting();
  const drainState = queue.getState();
  logger.info(
    { inFlight: drainState.inFlight, queueLength: drainState.queueLength },
    "Stop signal received; draining relay queue",
  );
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
      "Relay drain timeout reached; forcing shutdown",
    );
  }
  gateway.stop();
  devicePairingAutoApprover.stop();
  nodePairingAutoApprover.stop();
  execApprovalAutoApprover.stop();
  logger.info("Relay stopped");
}

main().catch((err) => {
  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    "Relay crashed",
  );
  process.exit(1);
});

type ChatPushMessage = InboundPushMessage & {
  input: Extract<InboundPushMessage["input"], { kind: "chat" }>;
};

function isUserChatMessage(
  message: InboundPushMessage,
): message is ChatPushMessage {
  return message.input.kind === "chat" && !isSystemReminderMessage(message);
}

function isSystemReminderMessage(
  message: InboundPushMessage,
): message is ChatPushMessage {
  if (message.input.kind !== "chat") {
    return false;
  }
  const context = message.input.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return false;
  }
  const kind = (context as { kind?: unknown }).kind;
  return (
    kind === "relay_stale_timeout_reminder" || kind === "relay_status_nudge"
  );
}

async function recordTransportEventActivity(input: {
  activityIndex: ReturnType<typeof createConversationActivityIndex>;
  message: InboundPushMessage;
}): Promise<void> {
  if (input.message.input.kind !== "transport_event") return;
  const event = input.message.input.event;
  if (
    event.eventType !== "transport.message.received" &&
    event.eventType !== "transport.delivery.receipt"
  ) {
    return;
  }
  const payload = event.payload;
  const sessionKey =
    readString(payload.sessionKey) ?? readString(payload.conversationKey);
  if (!sessionKey) return;
  const channel =
    readConversationChannel(payload.channel) ??
    inferConversationChannel(sessionKey);
  const transportTarget = inferTransportTarget({
    sessionKey,
    channel,
    context: payload,
  });
  try {
    if (event.eventType === "transport.message.received") {
      await input.activityIndex.recordInbound({
        sessionKey,
        channel,
        transportTarget,
        text:
          readString(payload.text) ??
          readString(payload.messageText) ??
          undefined,
        at: input.message.sentAtMs ?? Date.now(),
      });
    } else {
      await input.activityIndex.recordOutbound({
        sessionKey,
        channel,
        transportTarget,
        at: input.message.sentAtMs ?? Date.now(),
      });
      const deliveryKind = readVisibleDeliveryKind(payload.deliveryKind);
      if (
        deliveryKind &&
        (payload.status === "sent" || payload.status === "delivered")
      ) {
        const deliveredAt = input.message.sentAtMs ?? Date.now();
        await input.activityIndex.recordVisibleDelivery({
          evidenceId:
            readString(payload.evidenceId) ??
            readString(payload.eventId) ??
            readString(payload.actionId) ??
            undefined,
          sessionKey,
          channel,
          transportTarget,
          sourceRequestId:
            readString(payload.sourceRequestId) ??
            readString(payload.backendMessageId) ??
            undefined,
          relayMessageId: input.message.messageId,
          runId: readString(payload.runId) ?? undefined,
          correlationMessageId:
            readString(payload.correlationMessageId) ?? undefined,
          visibleMessageId:
            readString(payload.visibleMessageId) ??
            readString(payload.actionId) ??
            undefined,
          transportMessageId:
            readString(payload.transportMessageId) ?? undefined,
          deliveryKind,
          visibleText:
            readString(payload.visibleText) ??
            readString(payload.text) ??
            undefined,
          mediaSummary: readString(payload.mediaSummary) ?? undefined,
          deliveredAt,
          recordedAt: Date.now(),
        });
      }
    }
  } catch (error) {
    logger.warn(
      {
        event: "conversation_activity",
        stage: "record_transport_event_failed",
        backendMessageId: input.message.messageId,
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to record conversation transport activity",
    );
  }
}

function readVisibleDeliveryKind(value: unknown) {
  if (
    value === "final" ||
    value === "tool" ||
    value === "block" ||
    value === "terminal_error" ||
    value === "terminal_no_reply"
  ) {
    return value;
  }
  return null;
}

function readConversationChannel(
  value: unknown,
): ReturnType<typeof inferConversationChannel> | null {
  if (
    value === "telegram" ||
    value === "whatsapp" ||
    value === "whatsapp_personal" ||
    value === "api" ||
    value === "webchat" ||
    value === "direct_openclaw" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function readServerIdFromTransportSessionKey(
  sessionKey: string,
): string | undefined {
  if (sessionKey.startsWith("tg:")) {
    return sessionKey.slice("tg:".length).split(":")[1]?.trim() || undefined;
  }
  if (sessionKey.startsWith("whatsapp-personal:")) {
    return (
      sessionKey.slice("whatsapp-personal:".length).split(":")[1]?.trim() ||
      undefined
    );
  }
  return undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
          ...(input.message.input.kind === "chat"
            ? { sessionKey: input.message.input.sessionKey }
            : {}),
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
      "Failed to submit dropped user chat callback",
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
          ...(input.message.input.kind === "chat"
            ? { sessionKey: input.message.input.sessionKey }
            : {}),
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
      "Failed to submit dropped system reminder callback",
    );
  }
}

function buildRelayDeliveryReportForBackend(
  cfg: RelayConfig,
  getHealth: () => Record<string, unknown>,
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

async function ensureGatewayConnected(
  gateway: GatewayClient,
  stop: { stopped: boolean },
) {
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
