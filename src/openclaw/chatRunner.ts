import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { collectTranscriptMedia, type TranscriptMediaFile } from "./mediaDirectives.js";
import { saveUploadedFiles } from "./fileUploads.js";
import { makeTextPreview } from "../common/utils/text.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { computeBackoffMs, sleep } from "../common/resilience/backoff.js";
import {
  composeMessageWithTranscript,
  logTranscriptionFailure,
  transcribeAudioWithDeepgram,
  type AudioTaskMedia,
  type TaskMedia,
} from "./transcription.js";

export type ChatRunResult =
  | { outcome: "reply"; reply: { message: unknown; runId: string; media?: TranscriptMediaFile[] } }
  | { outcome: "no_reply"; noReply?: { reason?: string; runId: string } }
  | { outcome: "error"; error: { code: string; message: string; runId?: string } };

type ChatRetryOptions = {
  attempts: number;
  baseDelayMs: number[];
  jitterMs: number;
};

type TranscriptionOptions = {
  apiKey?: string;
  language?: string;
  timeoutMs: number;
};

type Waiter = {
  resolve: (evt: ChatEvent) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

type ParsedInjectedStreamError = {
  code?: number;
  status?: string;
  message?: string;
};

type OpenclawChatMeta = {
  method: string;
  runId?: string;
  usage?: unknown;
  model?: string;
  usageIncoming?: unknown;
  usageOutgoing?: unknown;
};

type OpenclawSessionsUsageStats = {
  source: "sessions.usage";
  updatedAt?: number;
  startDate?: string;
  endDate?: string;
  totals?: Record<string, unknown>;
  aggregates?: {
    byModel?: Array<{
      provider?: string;
      model?: string;
      count?: number;
      totals?: Record<string, unknown>;
    }>;
  };
};

function composeProviderModelName(input: {
  provider?: unknown;
  model?: unknown;
}): { provider?: string; model?: string } {
  const provider =
    typeof input.provider === "string" && input.provider.trim().length > 0 ? input.provider.trim() : undefined;
  const model = typeof input.model === "string" && input.model.trim().length > 0 ? input.model.trim() : undefined;
  if (!provider && !model) return {};
  if (!provider) return { model };
  if (!model) return { provider };
  if (model.startsWith(`${provider}/`)) {
    return { provider, model };
  }
  return { provider, model: `${provider}/${model}` };
}

function tryParseInjectedStreamJsonError(text: string): ParsedInjectedStreamError | null {
  if (!text.includes("JSON error injected into SSE stream")) {
    return null;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const err = (parsed as { error?: unknown }).error;
    if (!err || typeof err !== "object") {
      return null;
    }
    const codeRaw = (err as { code?: unknown }).code;
    const statusRaw = (err as { status?: unknown }).status;
    const messageRaw = (err as { message?: unknown }).message;
    const code =
      typeof codeRaw === "number"
        ? codeRaw
        : typeof codeRaw === "string" && /^\d{3}$/.test(codeRaw.trim())
          ? Number.parseInt(codeRaw.trim(), 10)
          : undefined;
    const status = typeof statusRaw === "string" ? statusRaw : undefined;
    const message = typeof messageRaw === "string" ? messageRaw : undefined;
    return { code, status, message };
  } catch {
    return null;
  }
}

function classifyRetryableGatewayError(message: string): {
  retryable: boolean;
  reason: string;
  upstream?: ParsedInjectedStreamError;
} {
  const upstream = tryParseInjectedStreamJsonError(message);
  if (upstream?.code !== undefined) {
    if (upstream.code >= 500 && upstream.code <= 599) {
      return { retryable: true, reason: "upstream_5xx", upstream };
    }
    if (upstream.code === 429) {
      return { retryable: true, reason: "upstream_429", upstream };
    }
  }
  if (upstream?.status === "INTERNAL") {
    return { retryable: true, reason: "upstream_internal", upstream };
  }

  // Fallback heuristics: some upstream providers embed JSON-ish text in the message.
  if (/status"\s*:\s*"INTERNAL"/.test(message) && /"code"\s*:\s*5\d\d/.test(message)) {
    return { retryable: true, reason: "heuristic_internal" };
  }
  return { retryable: false, reason: "non_retryable" };
}

function resolveDefaultStateDir(): string {
  return resolveOpenclawStateDir(process.env);
}

async function listKnownSessionKeysFromState(): Promise<string[]> {
  const sessionsMapFile = path.join(resolveDefaultStateDir(), "agents", "main", "sessions", "sessions.json");
  const raw = await fs.readFile(sessionsMapFile, "utf8").catch(() => "");
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || (parsed as { constructor?: unknown }).constructor !== Object) {
    return [];
  }

  const out: string[] = [];
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (!key.startsWith("agent:main:")) continue;
    const sessionKey = key.slice("agent:main:".length).trim();
    if (sessionKey) out.push(sessionKey);
  }
  return out;
}

export class ChatRunner {
  private waitersByRunId = new Map<string, Waiter>();
  private runSessionByRunId = new Map<string, string>();
  private sessionMaintenanceLock: Promise<void> | null = null;
  private readonly devLogEnabled: boolean;
  private readonly devLogTextMaxLen: number;
  private readonly retry: ChatRetryOptions;
  private readonly transcription: TranscriptionOptions;
  private readonly transcribeAudio: (input: {
    media: AudioTaskMedia;
    apiKey: string;
    language?: string;
    timeoutMs: number;
  }) => Promise<string>;

  constructor(
    private readonly gateway: GatewayClient,
    opts?: {
      devLogEnabled?: boolean;
      devLogTextMaxLen?: number;
      retry?: Partial<ChatRetryOptions>;
      transcription?: Partial<TranscriptionOptions>;
      transcribeAudio?: (input: {
        media: AudioTaskMedia;
        apiKey: string;
        language?: string;
        timeoutMs: number;
      }) => Promise<string>;
    }
  ) {
    this.devLogEnabled = opts?.devLogEnabled ?? false;
    this.devLogTextMaxLen = opts?.devLogTextMaxLen ?? 200;
    this.retry = {
      attempts: Math.max(1, Math.trunc(opts?.retry?.attempts ?? 3)),
      baseDelayMs: Array.isArray(opts?.retry?.baseDelayMs)
        ? opts?.retry?.baseDelayMs.map((n) => Math.max(0, Math.trunc(n)))
        : [300, 800, 1500],
      jitterMs: Math.max(0, Math.trunc(opts?.retry?.jitterMs ?? 250)),
    };
    this.transcription = {
      apiKey: opts?.transcription?.apiKey,
      language: opts?.transcription?.language,
      timeoutMs: Math.max(1000, Math.trunc(opts?.transcription?.timeoutMs ?? 15_000)),
    };
    this.transcribeAudio = opts?.transcribeAudio ?? transcribeAudioWithDeepgram;
  }

  handleEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvt = parsed.data;
    if (chatEvt.state !== "final" && chatEvt.state !== "error" && chatEvt.state !== "aborted") {
      return;
    }
    if (this.devLogEnabled) {
      logger.debug({ runId: chatEvt.runId, state: chatEvt.state }, "Gateway chat event terminal");
    }
    const waiter = this.waitersByRunId.get(chatEvt.runId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waitersByRunId.delete(chatEvt.runId);
    this.runSessionByRunId.delete(chatEvt.runId);
    waiter.resolve(chatEvt);
  }

  async runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    media?: TaskMedia[];
    timeoutMs: number;
  }): Promise<{ result: ChatRunResult; openclawMeta: OpenclawChatMeta }> {
    await this.waitForSessionMaintenance();
    const baseMessageText = await this.resolveMessageText(input);
    const uploadedPaths = await saveUploadedFiles({ media: input.media });
    const messageText = composeMessageWithUploadedFiles(baseMessageText, uploadedPaths);
    const startedAtMs = Date.now();
    if (this.devLogEnabled) {
      logger.info(
        {
          event: "message_flow",
          direction: "relay_to_openclaw",
          stage: "request_sent",
          backendMessageId: input.taskId,
          relayMessageId: null,
          sessionKey: input.sessionKey,
          timeoutMs: input.timeoutMs,
          textLen: messageText.length,
          textPreview: makeTextPreview(messageText, this.devLogTextMaxLen),
        },
        "Message flow transition"
      );
    }
    const usageIncoming = await this.collectSessionsUsageStats({
      timeoutMs: Math.min(2_000, Math.max(400, Math.trunc(input.timeoutMs / 3))),
      attempts: 3,
    });
    if (!usageIncoming) {
      return {
        result: {
          outcome: "error",
          error: {
            code: "USAGE_REQUIRED",
            message: "sessions.usage is required before chat.send",
          },
        },
        openclawMeta: {
          method: "chat.send",
        },
      };
    }

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      const elapsedMs = Date.now() - startedAtMs;
      const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
      if (remainingMs < 300) {
        return {
          result: {
            outcome: "error",
            error: { code: "GATEWAY_TIMEOUT", message: "Timed out waiting for final" },
          },
          openclawMeta: {
            method: "chat.send",
            ...(usageIncoming ? { usageIncoming } : {}),
          },
        };
      }

      // `chat.send` is side-effecting; idempotencyKey must be stable across retries.
      let runId: string | null = null;
      try {
        const payload = await this.gateway.request("chat.send", {
          sessionKey: input.sessionKey,
          message: messageText,
          idempotencyKey: input.taskId,
          timeoutMs: remainingMs,
        });

        // Server will emit chat events keyed by runId.
        runId = extractRunId(payload);
        if (!runId) {
          if (this.devLogEnabled) {
            logger.warn({ taskId: input.taskId }, "Gateway did not return runId for chat.send");
          }
          return {
            result: { outcome: "error", error: { code: "NO_RUN_ID", message: "Gateway did not return runId" } },
            openclawMeta: {
              method: "chat.send",
              ...(usageIncoming ? { usageIncoming } : {}),
            },
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
        const retryable = attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
        logger.warn(
          {
            event: "message_flow",
            direction: "relay_to_openclaw",
            stage: "retrying",
            backendMessageId: input.taskId,
            relayMessageId: null,
            attempt,
            retryable,
            backoffMs,
            error: msg,
          },
          "Message flow transition"
        );
        if (!retryable) {
          return {
            result: { outcome: "error", error: { code: "GATEWAY_ERROR", message: `Gateway request failed: ${msg}` } },
            openclawMeta: {
              method: "chat.send",
              ...(usageIncoming ? { usageIncoming } : {}),
            },
          };
        }
        await sleep(backoffMs);
        continue;
      }

      try {
        if (this.devLogEnabled) {
          logger.debug({ taskId: input.taskId, runId, attempt }, "Relay waiting for chat final event");
        }
        this.runSessionByRunId.set(runId, input.sessionKey);
        const finalEvt = await this.waitForFinal(runId, remainingMs);
        this.runSessionByRunId.delete(runId);
        const usageOutgoing = await this.collectSessionsUsageStats({
          timeoutMs: Math.min(2_000, Math.max(400, remainingMs - 200)),
          attempts: 3,
        });
        if (!usageOutgoing) {
          return {
            result: {
              outcome: "error",
              error: {
                code: "USAGE_REQUIRED",
                message: "sessions.usage is required after chat.send",
                runId,
              },
            },
            openclawMeta: {
              method: "chat.send",
              runId,
              usageIncoming,
            },
          };
        }
        if (this.devLogEnabled) {
          logger.debug(
            {
              taskId: input.taskId,
              runId,
              state: finalEvt.state,
              stopReason: finalEvt.stopReason ?? null,
              usageIncoming: summarizeSessionsUsageForDebug(usageIncoming),
              usageOutgoing: summarizeSessionsUsageForDebug(usageOutgoing),
            },
            "Relay final chat usage report"
          );
        }
        if (finalEvt.state === "final") {
          if (finalEvt.message !== undefined) {
            if (this.devLogEnabled) {
              logger.info(
                {
                  event: "message_flow",
                  direction: "openclaw_to_relay",
                  stage: "response_received",
                  backendMessageId: input.taskId,
                  relayMessageId: null,
                  openclawRunId: runId,
                  outcome: "reply",
                  durationMs: Date.now() - startedAtMs,
                },
                "Message flow transition"
              );
            }
            const media = await collectTranscriptMedia({ sessionKey: input.sessionKey }).catch((err) => {
              if (this.devLogEnabled) {
                logger.warn(
                  { taskId: input.taskId, runId, err: err instanceof Error ? err.message : String(err) },
                  "Failed to collect transcript media"
                );
              }
              return [];
            });
            return {
              result: {
                outcome: "reply",
                reply: {
                  message: finalEvt.message,
                  runId,
                  ...(media.length > 0 ? { media } : {}),
                },
              },
              openclawMeta: {
                method: "chat.send",
                runId,
                usageIncoming,
                usageOutgoing,
              },
            };
          }
          if (this.devLogEnabled) {
            logger.info(
              {
                event: "message_flow",
                direction: "openclaw_to_relay",
                stage: "response_received",
                backendMessageId: input.taskId,
                relayMessageId: null,
                openclawRunId: runId,
                outcome: "no_reply",
                durationMs: Date.now() - startedAtMs,
              },
              "Message flow transition"
            );
          }
          return {
            result: { outcome: "no_reply", noReply: { runId } },
            openclawMeta: {
              method: "chat.send",
              runId,
              usageIncoming,
              usageOutgoing,
            },
          };
        }
        if (finalEvt.state === "aborted") {
          logger.warn(
            {
              event: "message_flow",
              direction: "openclaw_to_relay",
              stage: "failed",
              backendMessageId: input.taskId,
              relayMessageId: null,
              openclawRunId: runId,
              error: "Chat aborted",
            },
            "Message flow transition"
          );
          return {
            result: { outcome: "error", error: { code: "ABORTED", message: "Chat aborted", runId } },
            openclawMeta: {
              method: "chat.send",
              runId,
              usageIncoming,
              usageOutgoing,
            },
          };
        }

        // Always log gateway-provided error messages (even in production) so we can
        // debug issues like provider auth failures without enabling full dev logging.
        // Do not include user message text; only include the gateway error string.
        const gatewayErrorMessage = finalEvt.errorMessage ?? "Chat error";
        const classification = classifyRetryableGatewayError(gatewayErrorMessage);
        logger.warn(
          {
            event: "message_flow",
            direction: "openclaw_to_relay",
            stage: "failed",
            backendMessageId: input.taskId,
            relayMessageId: null,
            openclawRunId: runId,
            attempt,
            retryable: classification.retryable,
            reason: classification.reason,
            upstreamCode: classification.upstream?.code ?? null,
            upstreamStatus: classification.upstream?.status ?? null,
            errorMessageLen: gatewayErrorMessage.length,
            errorMessagePreview: makeTextPreview(gatewayErrorMessage, 500),
          },
          "Message flow transition"
        );

        const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
        const retryable =
          classification.retryable && attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
        if (!retryable) {
          return {
            result: {
              outcome: "error",
              error: { code: "GATEWAY_ERROR", message: gatewayErrorMessage, runId },
            },
            openclawMeta: {
              method: "chat.send",
              runId,
              usageIncoming,
              usageOutgoing,
            },
          };
        }
        await sleep(backoffMs);
      } catch (err) {
        // Best-effort abort, then optionally retry (timeouts can be transient).
        try {
          if (this.devLogEnabled) {
            logger.warn(
              { taskId: input.taskId, runId, attempt, err: err instanceof Error ? err.message : String(err) },
              "Relay timed out waiting for chat final; aborting"
            );
          }
          await this.gateway.request("chat.abort", { sessionKey: input.sessionKey, runId });
        } catch {
          if (this.devLogEnabled) {
            logger.warn({ taskId: input.taskId, runId, attempt }, "Relay failed to abort chat after timeout");
          }
        }

        this.runSessionByRunId.delete(runId);
        const msg = err instanceof Error ? err.message : "Timed out waiting for final";
        const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
        const retryable = attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
        if (!retryable) {
          return {
            result: { outcome: "error", error: { code: "GATEWAY_TIMEOUT", message: msg, runId } },
            openclawMeta: {
              method: "chat.send",
              runId,
              ...(usageIncoming ? { usageIncoming } : {}),
            },
          };
        }
        await sleep(backoffMs);
      }
    }

    // Should be unreachable due to loop returns, but keep a safe fallback.
    return {
      result: { outcome: "error", error: { code: "GATEWAY_ERROR", message: "Chat failed" } },
      openclawMeta: {
        method: "chat.send",
        ...(usageIncoming ? { usageIncoming } : {}),
      },
    };
  }

  async startNewSessionForAll(): Promise<{ reset: true; sessionsRotated: number; sessionsFailed: number }> {
    return this.withSessionMaintenanceLock(async () => {
      // Best-effort: abort active runs before rotating sessions with `/new`.
      const abortTargets = Array.from(this.runSessionByRunId.entries());
      for (const [runId, sessionKey] of abortTargets) {
        await this.gateway.request("chat.abort", { sessionKey, runId }).catch(() => undefined);
      }

      const knownFromState = await listKnownSessionKeysFromState();
      const knownFromActiveRuns = abortTargets.map(([, sessionKey]) => sessionKey);
      const sessionKeys = Array.from(new Set([...knownFromState, ...knownFromActiveRuns]));

      let sessionsRotated = 0;
      let sessionsFailed = 0;
      for (const sessionKey of sessionKeys) {
        try {
          const payload = await this.gateway.request("chat.send", {
            sessionKey,
            message: "/new",
            idempotencyKey: `session_new_${sessionKey}_${Date.now()}`,
            timeoutMs: 15_000,
          });
          const runId = extractRunId(payload);
          if (!runId) {
            throw new Error("Gateway did not return runId for /new");
          }
          this.runSessionByRunId.set(runId, sessionKey);
          try {
            const finalEvt = await this.waitForFinal(runId, 15_000);
            if (finalEvt.state === "error") {
              throw new Error(finalEvt.errorMessage ?? "Session rotation failed");
            }
            if (finalEvt.state === "aborted") {
              throw new Error("Session rotation was aborted");
            }
            sessionsRotated += 1;
          } finally {
            this.runSessionByRunId.delete(runId);
          }
        } catch {
          sessionsFailed += 1;
        }
      }
      return { reset: true as const, sessionsRotated, sessionsFailed };
    });
  }

  private async resolveMessageText(input: {
    taskId: string;
    messageText: string;
    media?: TaskMedia[];
  }): Promise<string> {
    const media = input.media?.find((item): item is AudioTaskMedia => item.type === "audio");
    if (!media) return input.messageText;
    const apiKey = this.transcription.apiKey?.trim();
    if (!apiKey) return input.messageText;

    try {
      const transcript = await this.transcribeAudio({
        media,
        apiKey,
        language: this.transcription.language,
        timeoutMs: this.transcription.timeoutMs,
      });
      return composeMessageWithTranscript({ messageText: input.messageText, transcript });
    } catch (error) {
      logTranscriptionFailure({ taskId: input.taskId, error });
      return input.messageText;
    }
  }

  private waitForFinal(runId: string, timeoutMs: number): Promise<ChatEvent> {
    return new Promise<ChatEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waitersByRunId.delete(runId);
        this.runSessionByRunId.delete(runId);
        reject(new Error("Timed out waiting for final"));
      }, timeoutMs);
      this.waitersByRunId.set(runId, { resolve, reject, timeout });
    });
  }

  private async waitForSessionMaintenance(): Promise<void> {
    if (!this.sessionMaintenanceLock) return;
    await this.sessionMaintenanceLock;
  }

  private async withSessionMaintenanceLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.sessionMaintenanceLock) {
      await this.sessionMaintenanceLock;
    }
    let release!: () => void;
    this.sessionMaintenanceLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await fn();
    } finally {
      this.sessionMaintenanceLock = null;
      release();
    }
  }

  private async collectSessionsUsageStats(input: {
    timeoutMs: number;
    attempts?: number;
  }): Promise<OpenclawSessionsUsageStats | undefined> {
    const perCallTimeoutMs = Math.max(300, Math.min(1500, Math.trunc(input.timeoutMs)));
    const attempts = Math.max(1, Math.min(3, Math.trunc(input.attempts ?? 3)));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Request global usage snapshot so totals/aggregates include all sessions,
      // all models, and the full available period. Do not trust `hello.features.methods`
      // for capability discovery because some OpenClaw versions implement
      // `sessions.usage` but do not advertise it.
      const payload = await this.gateway.getSessionsUsage({}, { timeoutMs: perCallTimeoutMs }).catch(() => undefined);
      if (!isPlainObject(payload)) {
        if (attempt < attempts) await sleep(attempt * 120);
        continue;
      }
      const out: OpenclawSessionsUsageStats = { source: "sessions.usage" };
      if (typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)) {
        out.updatedAt = payload.updatedAt;
      }
      if (typeof payload.startDate === "string" && payload.startDate.trim().length > 0) {
        out.startDate = payload.startDate;
      }
      if (typeof payload.endDate === "string" && payload.endDate.trim().length > 0) {
        out.endDate = payload.endDate;
      }
      if (isPlainObject(payload.totals)) {
        out.totals = payload.totals;
      }
      if (isPlainObject(payload.aggregates) && Array.isArray(payload.aggregates.byModel)) {
        out.aggregates = {
          byModel: payload.aggregates.byModel
            .filter((row): row is Record<string, unknown> => isPlainObject(row))
            .map((row) => {
              const normalizedModel = composeProviderModelName({
                provider: row.provider,
                model: row.model,
              });
              return {
                ...normalizedModel,
                ...(typeof row.count === "number" && Number.isFinite(row.count) ? { count: row.count } : {}),
                ...(isPlainObject(row.totals) ? { totals: row.totals } : {}),
              };
            }),
        };
      }
      return out;
    }
    return undefined;
  }
}

function summarizeSessionsUsageForDebug(snapshot: OpenclawSessionsUsageStats | undefined): Record<string, unknown> | null {
  if (!snapshot) return null;
  const byModel = Array.isArray(snapshot.aggregates?.byModel) ? snapshot.aggregates.byModel : [];
  return {
    source: snapshot.source,
    hasTotals: !!snapshot.totals,
    byModelCount: byModel.length,
    models: byModel
      .slice(0, 20)
      .map((row) => (typeof row.model === "string" ? row.model : null))
      .filter((row) => row !== null),
    updatedAt: snapshot.updatedAt ?? null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { constructor?: unknown }).constructor === Object
  );
}

function composeMessageWithUploadedFiles(messageText: string, uploadedPaths: string[]): string {
  if (!Array.isArray(uploadedPaths) || uploadedPaths.length === 0) return messageText;
  const suffix = uploadedPaths.map((filePath) => `File uploaded to: ${filePath}`).join("\n");
  const text = messageText.trim();
  return text ? `${text}\n${suffix}` : suffix;
}

function extractRunId(payload: unknown): string | null {
  // OpenClaw chat.send typically returns { runId, ... }.
  if (!payload || typeof payload !== "object") return null;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

