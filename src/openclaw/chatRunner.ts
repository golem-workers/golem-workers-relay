import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";
import { logger } from "../logger.js";
import { collectTranscriptMedia, type TranscriptMediaFile } from "./mediaDirectives.js";
import { saveUploadedFiles } from "./fileUploads.js";
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

function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

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

function computeBackoffMs(schedule: number[], attemptIndex: number, jitterMs: number): number {
  const base = schedule[Math.max(0, Math.min(schedule.length - 1, attemptIndex))] ?? 0;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return Math.max(0, Math.trunc(base) + jitter);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class ChatRunner {
  private waitersByRunId = new Map<string, Waiter>();
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
    waiter.resolve(chatEvt);
  }

  async runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    media?: TaskMedia[];
    timeoutMs: number;
  }): Promise<{ result: ChatRunResult; openclawMeta: OpenclawChatMeta }> {
    const baseMessageText = await this.resolveMessageText(input);
    const uploadedPaths = await saveUploadedFiles({ media: input.media });
    const messageText = composeMessageWithUploadedFiles(baseMessageText, uploadedPaths);
    const startedAtMs = Date.now();
    if (this.devLogEnabled) {
      logger.debug(
        {
          taskId: input.taskId,
          sessionKey: input.sessionKey,
          timeoutMs: input.timeoutMs,
          messageLen: messageText.length,
          messagePreview: makeTextPreview(messageText, this.devLogTextMaxLen),
        },
        "Relay starting chat task"
      );
    }
    const usageIncoming = await this.collectSessionsUsageStats({
      sessionKey: input.sessionKey,
      timeoutMs: Math.min(2_000, Math.max(400, Math.trunc(input.timeoutMs / 3))),
    });

    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      const elapsedMs = Date.now() - startedAtMs;
      const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
      if (remainingMs < 1000) {
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
          { taskId: input.taskId, attempt, retryable, backoffMs, err: msg },
          "Gateway request failed"
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
        const finalEvt = await this.waitForFinal(runId, remainingMs);
        const usageMeta = finalEvt.usage;
        const modelMeta = extractModelFromFinalEvent(finalEvt);
        const usageOutgoing = await this.collectSessionsUsageStats({
          sessionKey: input.sessionKey,
          timeoutMs: Math.min(2_000, Math.max(400, remainingMs - 200)),
          allowWhenMethodsMissing: true,
        });
        if (this.devLogEnabled) {
          logger.debug(
            {
              taskId: input.taskId,
              runId,
              state: finalEvt.state,
              stopReason: finalEvt.stopReason ?? null,
              usage: summarizeUsageForDebug(usageMeta),
              modelMeta: modelMeta ?? null,
              usageIncoming: summarizeSessionsUsageForDebug(usageIncoming),
              usageOutgoing: summarizeSessionsUsageForDebug(usageOutgoing),
            },
            "Relay final chat usage report"
          );
        }
        if (finalEvt.state === "final") {
          if (finalEvt.message !== undefined) {
            if (this.devLogEnabled) {
              logger.debug({ taskId: input.taskId, runId, outcome: "reply" }, "Relay chat task completed");
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
                ...(usageMeta !== undefined ? { usage: usageMeta } : {}),
                ...(modelMeta ? { model: modelMeta } : {}),
                ...(usageIncoming ? { usageIncoming } : {}),
                ...(usageOutgoing ? { usageOutgoing } : {}),
              },
            };
          }
          if (this.devLogEnabled) {
            logger.debug({ taskId: input.taskId, runId, outcome: "no_reply" }, "Relay chat task completed");
          }
          return {
            result: { outcome: "no_reply", noReply: { runId } },
            openclawMeta: {
              method: "chat.send",
              runId,
              ...(usageMeta !== undefined ? { usage: usageMeta } : {}),
              ...(modelMeta ? { model: modelMeta } : {}),
              ...(usageIncoming ? { usageIncoming } : {}),
              ...(usageOutgoing ? { usageOutgoing } : {}),
            },
          };
        }
        if (finalEvt.state === "aborted") {
          if (this.devLogEnabled) {
            logger.warn({ taskId: input.taskId, runId }, "Relay chat aborted");
          }
          return {
            result: { outcome: "error", error: { code: "ABORTED", message: "Chat aborted", runId } },
            openclawMeta: {
              method: "chat.send",
              runId,
              ...(usageMeta !== undefined ? { usage: usageMeta } : {}),
              ...(modelMeta ? { model: modelMeta } : {}),
              ...(usageIncoming ? { usageIncoming } : {}),
              ...(usageOutgoing ? { usageOutgoing } : {}),
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
            taskId: input.taskId,
            runId,
            attempt,
            retryable: classification.retryable,
            reason: classification.reason,
            upstreamCode: classification.upstream?.code ?? null,
            upstreamStatus: classification.upstream?.status ?? null,
            errorMessageLen: gatewayErrorMessage.length,
            errorMessagePreview: makeTextPreview(gatewayErrorMessage, 500),
          },
          "Relay chat gateway error"
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
              ...(usageMeta !== undefined ? { usage: usageMeta } : {}),
              ...(modelMeta ? { model: modelMeta } : {}),
              ...(usageIncoming ? { usageIncoming } : {}),
              ...(usageOutgoing ? { usageOutgoing } : {}),
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
        reject(new Error("Timed out waiting for final"));
      }, timeoutMs);
      this.waitersByRunId.set(runId, { resolve, reject, timeout });
    });
  }

  private async collectSessionsUsageStats(input: {
    sessionKey: string;
    timeoutMs: number;
    allowWhenMethodsMissing?: boolean;
  }): Promise<OpenclawSessionsUsageStats | undefined> {
    const hello = this.gateway.getHello();
    const supportedMethods = Array.isArray(hello?.features?.methods) ? new Set(hello.features.methods) : null;
    if (!supportedMethods && !input.allowWhenMethodsMissing) {
      return undefined;
    }
    if (supportedMethods && !supportedMethods.has("sessions.usage")) {
      return undefined;
    }
    const perCallTimeoutMs = supportedMethods
      ? Math.max(300, Math.min(1500, Math.trunc(input.timeoutMs)))
      : Math.max(80, Math.min(250, Math.trunc(input.timeoutMs / 8)));
    const payload = await this.gateway.getSessionsUsage({ limit: 50 }, { timeoutMs: perCallTimeoutMs }).catch(() => undefined);
    if (!isPlainObject(payload)) {
      return undefined;
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
          .map((row) => ({
            ...(typeof row.provider === "string" ? { provider: row.provider } : {}),
            ...(typeof row.model === "string" ? { model: row.model } : {}),
            ...(typeof row.count === "number" && Number.isFinite(row.count) ? { count: row.count } : {}),
            ...(isPlainObject(row.totals) ? { totals: row.totals } : {}),
          })),
      };
    }
    return out;
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const raw = source[key];
  if (typeof raw !== "string") return undefined;
  const next = raw.trim();
  return next.length > 0 ? next : undefined;
}

function readUsageNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.trunc(parsed));
      }
    }
  }
  return null;
}

function summarizeUsageForDebug(usageMeta: unknown): {
  hasUsage: boolean;
  type: string;
  keys: string[];
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  if (!usageMeta || typeof usageMeta !== "object" || (usageMeta as { constructor?: unknown }).constructor !== Object) {
    return {
      hasUsage: false,
      type: usageMeta === null ? "null" : typeof usageMeta,
      keys: [],
      model: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    };
  }
  const usage = usageMeta as Record<string, unknown>;
  return {
    hasUsage: true,
    type: "object",
    keys: Object.keys(usage).slice(0, 20),
    model:
      readString(usage, "model") ??
      readString(usage, "modelId") ??
      readString(usage, "providerModel") ??
      readString(usage, "llmModel") ??
      null,
    inputTokens: readUsageNumber(usage, ["inputTokens", "promptTokens", "input_tokens", "prompt_tokens"]),
    outputTokens: readUsageNumber(usage, [
      "outputTokens",
      "completionTokens",
      "output_tokens",
      "completion_tokens",
    ]),
    totalTokens: readUsageNumber(usage, ["totalTokens", "total_tokens"]),
  };
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

function extractModelFromFinalEvent(evt: ChatEvent): string | undefined {
  if (evt.usage && typeof evt.usage === "object" && (evt.usage as { constructor?: unknown }).constructor === Object) {
    const usage = evt.usage as Record<string, unknown>;
    return (
      readString(usage, "model") ??
      readString(usage, "modelId") ??
      readString(usage, "providerModel") ??
      readString(usage, "llmModel")
    );
  }
  if (evt.message && typeof evt.message === "object" && (evt.message as { constructor?: unknown }).constructor === Object) {
    const message = evt.message as Record<string, unknown>;
    return (
      readString(message, "model") ??
      readString(message, "modelId") ??
      readString(message, "providerModel") ??
      readString(message, "llmModel")
    );
  }
  return undefined;
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

