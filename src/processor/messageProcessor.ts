import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type BackendClient } from "../backend/backendClient.js";
import { type InboundPushMessage, type RelayInboundMessageRequest } from "../backend/types.js";
import { logger } from "../logger.js";
import { type ChatRunner } from "../openclaw/chatRunner.js";
import { type GatewayClient } from "../openclaw/gatewayClient.js";
import { makeTextPreview } from "../common/utils/text.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

type MessageProcessorInput = {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    chatBatchDebounceMs: number;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  readDiskUsage?: (path: string) => Promise<DiskUsageSnapshot>;
};

type DiskUsageSnapshot = {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type ArtifactResolutionIssue = {
  source?: string;
  reason?: string;
  path?: string;
  fileName?: string;
  kind?: string;
  contentType?: string;
  sizeBytes?: number;
  candidatePaths?: string[];
};

type ArtifactDeliveryMeta = {
  stage: "retry_notice" | "retry_succeeded" | "fallback_text" | "failure_notice";
  originalRunId?: string;
  retryRunId?: string;
  retryOutcome?: string;
  unresolvedCount?: number;
  unresolvedReasons?: Record<string, number>;
};

export function createMessageProcessor(input: MessageProcessorInput): (msg: InboundPushMessage) => Promise<void> {
  const { cfg, gateway, runner, backend } = input;
  const readDiskUsage = input.readDiskUsage ?? readDiskUsageSnapshot;
  const chatBatchesBySession = new Map<string, ChatBatchState>();
  const chatBatchDebounceMs = Math.max(0, Math.trunc(cfg.chatBatchDebounceMs));

  return async (msg: InboundPushMessage): Promise<void> => {
    if (msg.input.kind !== "chat" || chatBatchDebounceMs === 0) {
      await processSingleMessage({ cfg, gateway, runner, backend, msg, readDiskUsage });
      return;
    }
    await enqueueChatBatch({
      sessionKey: msg.input.sessionKey,
      msg,
      debounceMs: chatBatchDebounceMs,
      chatBatchesBySession,
      flush: async (items) => {
        await flushChatBatch({ cfg, gateway, runner, backend, items, readDiskUsage });
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
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  items: ChatBatchItem[];
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
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
        readDiskUsage: input.readDiskUsage,
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
      readDiskUsage: input.readDiskUsage,
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
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  gateway: GatewayClient;
  runner: ChatRunner;
  backend: BackendClient;
  msg: InboundPushMessage;
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
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

      await maybeSubmitLowDiskSpaceAlert({
        cfg,
        backend,
        correlationMessageId: msg.messageId,
        parentRelayMessageId: relayMessageId,
        readDiskUsage: input.readDiskUsage,
      });

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
          const unresolvedArtifacts = readArtifactResolutionIssues(result.reply);
          if (unresolvedArtifacts.length > 0) {
            const unresolvedArtifactReasons = countArtifactResolutionReasons(unresolvedArtifacts);
            const unresolvedArtifactDetails = summarizeArtifactResolutionIssues(unresolvedArtifacts);
            logger.warn(
              {
                event: "artifact_delivery",
                stage: "retry_requested",
                backendMessageId: msg.messageId,
                relayMessageId,
                unresolvedCount: unresolvedArtifacts.length,
                unresolvedArtifactReasons,
                unresolvedArtifactDetails,
                unresolvedArtifacts,
              },
              "Reply contains unresolved artifacts; scheduling one internal retry"
            );
            await submitReplyCallback({
              cfg,
              backend,
              correlationMessageId: msg.messageId,
              reply: {
                message: buildArtifactRetryNotice(),
                runId: `${result.reply.runId}:artifact-retry-notice`,
              },
              openclawMeta: {
                method: "artifact.retry_notice",
                runId: `${result.reply.runId}:artifact-retry-notice`,
                artifactDelivery: {
                  stage: "retry_notice",
                  originalRunId: result.reply.runId,
                  unresolvedCount: unresolvedArtifacts.length,
                  unresolvedReasons: unresolvedArtifactReasons,
                } satisfies ArtifactDeliveryMeta,
              },
            });

            const retryTimeoutMs = Math.max(0, cfg.taskTimeoutMs - (Date.now() - startedAt));
            if (retryTimeoutMs > 1000) {
              const retryOutcome = await runner.runChatTask({
                taskId: `${msg.messageId}:artifact-retry`,
                sessionKey: msg.input.sessionKey,
                messageText: buildArtifactRetryPrompt({ unresolved: unresolvedArtifacts }),
                timeoutMs: retryTimeoutMs,
              });
              if (
                retryOutcome.result.outcome === "reply" &&
                readArtifactResolutionIssues(retryOutcome.result.reply).length === 0
              ) {
                logger.info(
                  {
                    event: "artifact_delivery",
                    stage: "retry_succeeded",
                    backendMessageId: msg.messageId,
                    originalRunId: result.reply.runId,
                    retryRunId: retryOutcome.result.reply.runId,
                    artifactCount: retryOutcome.result.reply.artifacts?.length ?? 0,
                  },
                  "Artifact retry succeeded"
                );
                await submitReplyCallback({
                  cfg,
                  backend,
                  correlationMessageId: msg.messageId,
                  reply: retryOutcome.result.reply,
                  openclawMeta: {
                    ...normalizeOpenclawMeta(retryOutcome.openclawMeta),
                    artifactDelivery: {
                      stage: "retry_succeeded",
                      originalRunId: result.reply.runId,
                      retryRunId: retryOutcome.result.reply.runId,
                      unresolvedCount: unresolvedArtifacts.length,
                      unresolvedReasons: unresolvedArtifactReasons,
                    } satisfies ArtifactDeliveryMeta,
                  },
                });
              } else {
                const retryIssues =
                  retryOutcome.result.outcome === "reply"
                    ? readArtifactResolutionIssues(retryOutcome.result.reply)
                    : [];
                logger.warn(
                  {
                    event: "artifact_delivery",
                    stage: "retry_failed",
                    backendMessageId: msg.messageId,
                    originalRunId: result.reply.runId,
                    retryOutcome: retryOutcome.result.outcome,
                    retryIssueReasons: countArtifactResolutionReasons(retryIssues),
                    retryIssueDetails: summarizeArtifactResolutionIssues(retryIssues),
                    retryIssues,
                  },
                  "Artifact retry did not produce deliverable artifacts"
                );
                const originalText = extractReplyText(result.reply.message);
                if (originalText) {
                  await submitReplyCallback({
                    cfg,
                    backend,
                    correlationMessageId: msg.messageId,
                    reply: {
                      message: originalText,
                      runId: `${result.reply.runId}:artifact-fallback-text`,
                    },
                    openclawMeta: {
                      method: "artifact.fallback_text",
                      runId: `${result.reply.runId}:artifact-fallback-text`,
                      artifactDelivery: {
                        stage: "fallback_text",
                        originalRunId: result.reply.runId,
                        retryRunId:
                          retryOutcome.result.outcome === "reply" ? retryOutcome.result.reply.runId : undefined,
                        retryOutcome: retryOutcome.result.outcome,
                        unresolvedCount: unresolvedArtifacts.length,
                        unresolvedReasons: countArtifactResolutionReasons(retryIssues),
                      } satisfies ArtifactDeliveryMeta,
                    },
                  });
                }
                await submitReplyCallback({
                  cfg,
                  backend,
                  correlationMessageId: msg.messageId,
                  reply: {
                    message: buildArtifactFailureNotice(),
                    runId: `${result.reply.runId}:artifact-failure-notice`,
                  },
                  openclawMeta: {
                    method: "artifact.failure_notice",
                    runId: `${result.reply.runId}:artifact-failure-notice`,
                    artifactDelivery: {
                      stage: "failure_notice",
                      originalRunId: result.reply.runId,
                      retryRunId:
                        retryOutcome.result.outcome === "reply" ? retryOutcome.result.reply.runId : undefined,
                      retryOutcome: retryOutcome.result.outcome,
                      unresolvedCount: unresolvedArtifacts.length,
                      unresolvedReasons: countArtifactResolutionReasons(retryIssues),
                    } satisfies ArtifactDeliveryMeta,
                  },
                });
              }
            } else {
              logger.warn(
                {
                  event: "artifact_delivery",
                  stage: "retry_skipped",
                  backendMessageId: msg.messageId,
                  relayMessageId,
                  retryTimeoutMs,
                },
                "Artifact retry skipped because there was not enough remaining time"
              );
              const originalText = extractReplyText(result.reply.message);
              if (originalText) {
                await submitReplyCallback({
                  cfg,
                  backend,
                  correlationMessageId: msg.messageId,
                  reply: {
                    message: originalText,
                    runId: `${result.reply.runId}:artifact-fallback-text`,
                  },
                  openclawMeta: {
                    method: "artifact.fallback_text",
                    runId: `${result.reply.runId}:artifact-fallback-text`,
                    artifactDelivery: {
                      stage: "fallback_text",
                      originalRunId: result.reply.runId,
                      retryOutcome: "retry_skipped",
                      unresolvedCount: unresolvedArtifacts.length,
                      unresolvedReasons: unresolvedArtifactReasons,
                    } satisfies ArtifactDeliveryMeta,
                  },
                });
              }
              await submitReplyCallback({
                cfg,
                backend,
                correlationMessageId: msg.messageId,
                reply: {
                  message: buildArtifactFailureNotice(),
                  runId: `${result.reply.runId}:artifact-failure-notice`,
                },
                openclawMeta: {
                  method: "artifact.failure_notice",
                  runId: `${result.reply.runId}:artifact-failure-notice`,
                  artifactDelivery: {
                    stage: "failure_notice",
                    originalRunId: result.reply.runId,
                    retryOutcome: "retry_skipped",
                    unresolvedCount: unresolvedArtifacts.length,
                    unresolvedReasons: unresolvedArtifactReasons,
                  } satisfies ArtifactDeliveryMeta,
                },
              });
            }
          } else {
            await backend.submitInboundMessage({
              body: {
                relayInstanceId: cfg.relayInstanceId,
                relayMessageId,
                finishedAtMs,
                outcome: "reply",
                reply: await buildReplyPayload(result.reply),
                openclawMeta: buildOpenclawMetaWithTrace(normalizeOpenclawMeta(openclawMeta), {
                  backendMessageId: msg.messageId,
                  relayMessageId,
                  relayInstanceId: cfg.relayInstanceId,
                  openclawRunId: result.reply.runId,
                }),
              },
            });
          }
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

async function maybeSubmitLowDiskSpaceAlert(input: {
  cfg: {
    relayInstanceId: string;
    lowDiskAlertEnabled?: boolean;
    lowDiskAlertThresholdPercent?: number;
  };
  backend: BackendClient;
  correlationMessageId: string;
  parentRelayMessageId: string;
  readDiskUsage: (path: string) => Promise<DiskUsageSnapshot>;
}): Promise<void> {
  if (input.cfg.lowDiskAlertEnabled !== true) {
    return;
  }
  const checkedPath = resolveOpenclawStateDir(process.env);
  try {
    const usage = await input.readDiskUsage(checkedPath);
    if (usage.usedPercent < (input.cfg.lowDiskAlertThresholdPercent ?? 80)) {
      return;
    }
    await input.backend.submitInboundMessage({
      body: {
        relayInstanceId: input.cfg.relayInstanceId,
        relayMessageId: `${input.parentRelayMessageId}:disk-space-low`,
        finishedAtMs: Date.now(),
        outcome: "technical",
        technical: {
          source: "relay",
          event: "disk.space_low",
          checkedPath,
          thresholdPercent: input.cfg.lowDiskAlertThresholdPercent ?? 80,
          usedPercent: usage.usedPercent,
          usedBytes: usage.usedBytes,
          availableBytes: usage.availableBytes,
          totalBytes: usage.totalBytes,
        },
        openclawMeta: buildOpenclawMetaWithTrace(
          { method: "relay.disk.check" },
          {
            backendMessageId: input.correlationMessageId,
            relayMessageId: `${input.parentRelayMessageId}:disk-space-low`,
            relayInstanceId: input.cfg.relayInstanceId,
          }
        ),
      },
    });
  } catch (error) {
    logger.warn(
      {
        event: "relay_disk_space_check",
        relayInstanceId: input.cfg.relayInstanceId,
        checkedPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "Relay failed to evaluate disk usage"
    );
  }
}

async function readDiskUsageSnapshot(targetPath: string): Promise<DiskUsageSnapshot> {
  const stats = await fs.statfs(targetPath);
  const blockSize = stats.bsize;
  const totalBytes = Number(stats.blocks) * blockSize;
  const availableBytes = Number(stats.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usedPercent = totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : 0;
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent,
  };
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function normalizeOpenclawMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const method = readNonEmptyString(meta.method);
  const runId = readNonEmptyString(meta.runId);
  const model = readNonEmptyString(meta.model);
  const trace = normalizeOpenclawMetaTrace(meta.trace);
  const artifactDelivery = normalizeArtifactDeliveryMeta(meta.artifactDelivery);
  const deliverySystem =
    meta.deliverySystem === "relay_channel_v2" || meta.deliverySystem === "legacy_push_v1"
      ? meta.deliverySystem
      : undefined;
  const transportChannelId = readNonEmptyString(meta.transportChannelId);
  const transportAccountId = readNonEmptyString(meta.transportAccountId);
  const transportMessageId = readNonEmptyString(meta.transportMessageId);
  const normalized = {
    ...(method ? { method } : {}),
    ...(runId ? { runId } : {}),
    ...(model ? { model } : {}),
    ...(artifactDelivery ? { artifactDelivery } : {}),
    ...(trace ? { trace } : {}),
    ...(deliverySystem ? { deliverySystem } : {}),
    ...(transportChannelId ? { transportChannelId } : {}),
    ...(transportAccountId ? { transportAccountId } : {}),
    ...(transportMessageId ? { transportMessageId } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildOpenclawMetaWithTrace(
  meta: Record<string, unknown> | undefined,
  trace: {
    backendMessageId: string;
    relayMessageId: string;
    relayInstanceId: string;
    openclawRunId?: string;
  },
  deliveryOpts?: {
    deliverySystem?: "legacy_push_v1" | "relay_channel_v2";
    transportChannelId?: string;
    transportAccountId?: string;
    transportMessageId?: string;
  }
): Record<string, unknown> {
  const base = normalizeOpenclawMeta(meta) ?? {};
  const fromBase = base.deliverySystem;
  const deliverySystem =
    deliveryOpts?.deliverySystem ??
    (fromBase === "legacy_push_v1" || fromBase === "relay_channel_v2" ? fromBase : "legacy_push_v1");
  const transportChannelId =
    readNonEmptyString(deliveryOpts?.transportChannelId) ?? readNonEmptyString(base.transportChannelId);
  const transportAccountId =
    readNonEmptyString(deliveryOpts?.transportAccountId) ?? readNonEmptyString(base.transportAccountId);
  const transportMessageId =
    readNonEmptyString(deliveryOpts?.transportMessageId) ?? readNonEmptyString(base.transportMessageId);
  return {
    ...base,
    trace: {
      backendMessageId: trace.backendMessageId,
      relayMessageId: trace.relayMessageId,
      relayInstanceId: trace.relayInstanceId,
      ...(trace.openclawRunId ? { openclawRunId: trace.openclawRunId } : {}),
    },
    deliverySystem,
    ...(transportChannelId ? { transportChannelId } : {}),
    ...(transportAccountId ? { transportAccountId } : {}),
    ...(transportMessageId ? { transportMessageId } : {}),
  };
}

function normalizeOpenclawMetaTrace(trace: unknown): Record<string, string> | undefined {
  if (!isPlainObject(trace)) return undefined;
  const backendMessageId = readNonEmptyString(trace.backendMessageId);
  const relayMessageId = readNonEmptyString(trace.relayMessageId);
  const relayInstanceId = readNonEmptyString(trace.relayInstanceId);
  const openclawRunId = readNonEmptyString(trace.openclawRunId);
  const normalized = {
    ...(backendMessageId ? { backendMessageId } : {}),
    ...(relayMessageId ? { relayMessageId } : {}),
    ...(relayInstanceId ? { relayInstanceId } : {}),
    ...(openclawRunId ? { openclawRunId } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeArtifactDeliveryMeta(meta: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(meta)) return undefined;
  const stage = readNonEmptyString(meta.stage);
  const originalRunId = readNonEmptyString(meta.originalRunId);
  const retryRunId = readNonEmptyString(meta.retryRunId);
  const retryOutcome = readNonEmptyString(meta.retryOutcome);
  const unresolvedCount =
    typeof meta.unresolvedCount === "number" && Number.isFinite(meta.unresolvedCount)
      ? meta.unresolvedCount
      : undefined;
  const unresolvedReasons = isPlainObject(meta.unresolvedReasons)
    ? Object.fromEntries(
        Object.entries(meta.unresolvedReasons).filter(
          (entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number"
        )
      )
    : undefined;
  const normalized = {
    ...(stage ? { stage } : {}),
    ...(originalRunId ? { originalRunId } : {}),
    ...(retryRunId ? { retryRunId } : {}),
    ...(retryOutcome ? { retryOutcome } : {}),
    ...(unresolvedCount !== undefined ? { unresolvedCount } : {}),
    ...(unresolvedReasons && Object.keys(unresolvedReasons).length > 0 ? { unresolvedReasons } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function buildReplyPayload(reply: {
  message: unknown;
  runId: string;
  artifacts?: Array<{
    path: string;
    fileName: string;
    kind: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }>;
  media?: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
}): Promise<Extract<RelayInboundMessageRequest, { outcome: "reply" }>["reply"]> {
  const normalizedMessage = normalizeReplyMessage(reply.message);
  const extracted = await extractInlineReplyMedia(normalizedMessage);
  const payload: Extract<RelayInboundMessageRequest, { outcome: "reply" }>["reply"] = {
    ...(isPlainObject(reply) ? reply : {}),
    runId: reply.runId,
    message: extracted.message,
  };
  const allArtifacts = normalizeReplyArtifacts([
    ...(Array.isArray(reply.artifacts) ? reply.artifacts : []),
    ...(Array.isArray(reply.media) ? reply.media.map((item) => toReplyArtifact(item)) : []),
    ...extracted.media.map((item) => toReplyArtifact(item)),
  ]);
  if (allArtifacts.length > 0) {
    payload.artifacts = allArtifacts;
    payload.media = allArtifacts.map((artifact) => ({
      path: artifact.path,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
    }));
  }
  return payload;
}

function extractReplyText(message: unknown): string {
  if (typeof message === "string") return message.trim();
  if (!isPlainObject(message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (typeof message.text === "string") return message.text.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function readArtifactResolutionIssues(reply: {
  artifactResolution?: {
    unresolved?: ArtifactResolutionIssue[];
  };
}): ArtifactResolutionIssue[] {
  return Array.isArray(reply.artifactResolution?.unresolved) ? reply.artifactResolution.unresolved : [];
}

function summarizeArtifactResolutionIssues(
  issues: ArtifactResolutionIssue[]
): Array<{
  source: string | null;
  reason: string | null;
  path: string | null;
  fileName: string | null;
  kind: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  candidatePaths: string[];
}> {
  return issues.map((issue) => ({
    source: typeof issue.source === "string" ? issue.source : null,
    reason: typeof issue.reason === "string" ? issue.reason : null,
    path: typeof issue.path === "string" ? issue.path : null,
    fileName: typeof issue.fileName === "string" ? issue.fileName : null,
    kind: typeof issue.kind === "string" ? issue.kind : null,
    contentType: typeof issue.contentType === "string" ? issue.contentType : null,
    sizeBytes: typeof issue.sizeBytes === "number" ? issue.sizeBytes : null,
    candidatePaths: Array.isArray(issue.candidatePaths)
      ? issue.candidatePaths.filter((candidatePath): candidatePath is string => typeof candidatePath === "string")
      : [],
  }));
}

function countArtifactResolutionReasons(issues: ArtifactResolutionIssue[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    const reason = typeof issue.reason === "string" && issue.reason.length > 0 ? issue.reason : "unspecified";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function buildArtifactRetryNotice(): string {
  return "We hit a temporary issue while preparing the file attachment. We are trying one more time now.";
}

function buildArtifactFailureNotice(): string {
  return "Technical note: the agent message was delivered, but the file attachment could not be sent.";
}

function buildArtifactRetryPrompt(input: {
  unresolved: ArtifactResolutionIssue[];
}): string {
  const details = input.unresolved
    .map((issue, index) => {
      const parts = [
        `Artifact ${index + 1}:`,
        issue.path ? `requestedPath=${issue.path}` : null,
        issue.fileName ? `fileName=${issue.fileName}` : null,
        issue.kind ? `kind=${issue.kind}` : null,
        issue.contentType ? `contentType=${issue.contentType}` : null,
        typeof issue.sizeBytes === "number" ? `sizeBytes=${issue.sizeBytes}` : null,
        issue.reason ? `reason=${issue.reason}` : null,
        Array.isArray(issue.candidatePaths) && issue.candidatePaths.length > 0
          ? `candidatePaths=${issue.candidatePaths.join(", ")}`
          : null,
      ].filter(Boolean);
      return parts.join("; ");
    })
    .join("\n");
  return [
    "[System note]",
    "Your previous answer referenced one or more file artifacts that the relay could not resolve unambiguously.",
    "Inspect the current OpenClaw workspace and reply again without regenerating the file unless that is truly necessary.",
    "Return the same user-facing answer if it is still correct, but include the correct artifact path in the reply artifacts / MEDIA reference so the relay can attach the file.",
    "If multiple matching files exist, choose the exact one you created and reference its precise workspace-relative path.",
    details ? `Unresolved artifacts:\n${details}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function submitReplyCallback(input: {
  cfg: {
    relayInstanceId: string;
    taskTimeoutMs: number;
    chatBatchDebounceMs: number;
    devLogEnabled: boolean;
    devLogTextMaxLen: number;
  };
  backend: BackendClient;
  correlationMessageId: string;
  reply: {
    message: unknown;
    runId: string;
    artifacts?: Array<{
      path: string;
      fileName: string;
      kind: "image" | "video" | "audio" | "file";
      contentType: string;
      sizeBytes: number;
    }>;
    media?: Array<{
      path: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
    }>;
  };
  openclawMeta?: unknown;
}): Promise<string> {
  const relayMessageId = `relay_${randomUUID()}`;
  const finishedAtMs = Date.now();
  await input.backend.submitInboundMessage({
    body: {
      relayInstanceId: input.cfg.relayInstanceId,
      relayMessageId,
      finishedAtMs,
      outcome: "reply",
      reply: await buildReplyPayload(input.reply),
      openclawMeta: buildOpenclawMetaWithTrace(normalizeOpenclawMeta(input.openclawMeta), {
        backendMessageId: input.correlationMessageId,
        relayMessageId,
        relayInstanceId: input.cfg.relayInstanceId,
        openclawRunId: input.reply.runId,
      }),
    },
  });
  logger.info(
    {
      event: "message_flow",
      direction: "relay_to_backend",
      stage: "callback_sent",
      backendMessageId: input.correlationMessageId,
      relayMessageId,
      durationMs: 0,
      supplemental: true,
    },
    "Message flow transition"
  );
  return relayMessageId;
}

function inferArtifactKind(contentType: string): "image" | "video" | "audio" | "file" {
  const normalized = contentType.trim().toLowerCase();
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "file";
}

function toReplyArtifact(item: {
  path: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  kind?: "image" | "video" | "audio" | "file";
}): {
  path: string;
  fileName: string;
  kind: "image" | "video" | "audio" | "file";
  contentType: string;
  sizeBytes: number;
} {
  return {
    path: item.path,
    fileName: item.fileName,
    kind: item.kind ?? inferArtifactKind(item.contentType),
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
  };
}

function normalizeReplyArtifacts(
  artifacts: Array<{
    path: string;
    fileName: string;
    kind?: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }>
): Array<{
  path: string;
  fileName: string;
  kind: "image" | "video" | "audio" | "file";
  contentType: string;
  sizeBytes: number;
}> {
  const normalized: Array<{
    path: string;
    fileName: string;
    kind: "image" | "video" | "audio" | "file";
    contentType: string;
    sizeBytes: number;
  }> = [];
  const seen = new Set<string>();

  for (const item of artifacts) {
    const path = readNonEmptyString(item.path);
    const fileName = readNonEmptyString(item.fileName);
    const kind = item.kind ?? (item.contentType ? inferArtifactKind(item.contentType) : "file");
    const contentType = readNonEmptyString(item.contentType);
    const sizeBytes = Number.isFinite(item.sizeBytes) ? Math.trunc(item.sizeBytes) : 0;

    if (!path || !fileName || !contentType || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      continue;
    }
    const dedupeKey = `${path}\u0000${fileName}\u0000${kind}\u0000${contentType}\u0000${sizeBytes}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      path,
      fileName,
      kind,
      contentType,
      sizeBytes,
    });
  }

  return normalized;
}

async function extractInlineReplyMedia(message: unknown): Promise<{
  message: unknown;
  media: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
}> {
  if (!isPlainObject(message) || !Array.isArray(message.content)) {
    return { message, media: [] };
  }
  const content: unknown[] = [];
  const media: Array<{
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }> = [];
  for (const part of message.content) {
    const extracted = await extractInlineReplyMediaPart(part);
    if (extracted.media) {
      media.push(extracted.media);
      continue;
    }
    content.push(extracted.part);
  }
  return {
    message: {
      ...message,
      content,
    },
    media,
  };
}

async function extractInlineReplyMediaPart(part: unknown): Promise<{
  part: unknown;
  media?: {
    path: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  };
}> {
  if (!isPlainObject(part) || part.type !== "image") {
    return { part };
  }
  const rawData = readNonEmptyString(part.data);
  if (!rawData) {
    return { part };
  }
  const parsed = parseInlineImagePayload(rawData, readNonEmptyString(part.mimeType));
  if (!parsed) {
    return { part };
  }
  const persisted = await persistInlineReplyMedia({
    payload: parsed.dataB64,
    contentType: parsed.contentType,
    fileName: readNonEmptyString(part.fileName),
  });
  const sanitizedPart = { ...part };
  delete sanitizedPart.data;
  return {
    part: {
      ...sanitizedPart,
      dataPreview: {
        dataPrefix: parsed.dataB64.slice(0, 128),
        dataLength: parsed.dataB64.length,
        truncated: true,
      },
    },
    media: persisted,
  };
}

function parseInlineImagePayload(
  value: string,
  mimeType: string | undefined
): { dataB64: string; contentType: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dataUrlMatch = /^data:([^;]+);base64,(.*)$/i.exec(trimmed);
  if (dataUrlMatch?.[2]) {
    return {
      contentType: (dataUrlMatch[1] ?? mimeType ?? "image/png").trim() || "image/png",
      dataB64: dataUrlMatch[2].trim(),
    };
  }
  return {
    contentType: mimeType?.trim() || "image/png",
    dataB64: trimmed,
  };
}

async function persistInlineReplyMedia(input: {
  payload: string;
  contentType: string;
  fileName?: string;
}): Promise<{ path: string; fileName: string; contentType: string; sizeBytes: number }> {
  const stateDir = resolveOpenclawStateDir(process.env);
  const workspaceDir = path.join(stateDir, "workspace", "files", "inline-reply");
  await fs.mkdir(workspaceDir, { recursive: true });
  const ext = inferFileExtension(input.fileName, input.contentType);
  const fileName = sanitizeFileName(input.fileName, ext);
  const uniqueName = `${Date.now()}-${randomUUID()}-${fileName}`;
  const absolutePath = path.join(workspaceDir, uniqueName);
  const buffer = Buffer.from(input.payload, "base64");
  await fs.writeFile(absolutePath, buffer);
  return {
    path: path.posix.join("files", "inline-reply", uniqueName),
    fileName,
    contentType: input.contentType,
    sizeBytes: buffer.byteLength,
  };
}

function inferFileExtension(fileName: string | undefined, contentType: string): string {
  const ext = path.extname((fileName ?? "").trim()).replace(/^\./, "");
  if (ext) return ext;
  const normalized = contentType.toLowerCase();
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("svg")) return "svg";
  return "png";
}

function sanitizeFileName(fileName: string | undefined, ext: string): string {
  const rawBase = path.basename((fileName ?? "").trim()) || `image.${ext}`;
  const safe = rawBase.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe || `image.${ext}`;
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
