import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import {
  collectTranscriptArtifacts,
  extractMediaDirectivePaths,
  extractNativeMediaDirectivePaths,
  type TranscriptArtifact,
  type TranscriptArtifactCollectionReport,
  type TranscriptMediaFile,
} from "./mediaDirectives.js";
import { saveUploadedFiles } from "./fileUploads.js";
import { makeTextPreview } from "../common/utils/text.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { computeBackoffMs, sleep } from "../common/resilience/backoff.js";
import {
  composeMessageWithTranscript,
  logTranscriptionFailure,
  type AudioTaskMedia,
  type ImageTaskMedia,
  type TaskMedia,
} from "./transcription.js";
import { transcribeAudioWithOpenAi } from "./openaiTranscription.js";
import { prepareChatMedia } from "./mediaPreprocess.js";

export type ChatRunResult =
  | {
      outcome: "reply";
      reply: {
        message: unknown;
        runId: string;
        artifacts?: TranscriptArtifact[];
        media?: TranscriptMediaFile[];
        artifactResolution?: TranscriptArtifactCollectionReport;
        openclawEvents?: ChatEvent[];
      };
    }
  | {
      outcome: "no_reply";
      noReply?: {
        reason?: string;
        runId: string;
        openclawEvents?: ChatEvent[];
      };
    }
  | {
      outcome: "error";
      error: {
        code: string;
        message: string;
        runId?: string;
        openclawEvents?: ChatEvent[];
      };
    };

type ChatRetryOptions = {
  attempts: number;
  baseDelayMs: number[];
  jitterMs: number;
};

type TranscriptionOptions = {
  baseUrl: string;
  relayToken: string;
  model: string;
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
  model?: string;
};

type DeliverySystem = "legacy_push_v1" | "relay_channel_v2";

const TRANSPORT_INTERRUPTION_PATTERNS = [
  /network connection lost/i,
  /socket hang up/i,
  /\beconnreset\b/i,
  /\beconnaborted\b/i,
  /\betimedout\b/i,
  /stream ended unexpectedly/i,
  /connection closed/i,
  /upstream disconnected/i,
] as const;

const TRANSPORT_RECOVERY_NOTE = [
  "[System note]",
  "The previous attempt ended due to a network interruption after partial tool execution.",
  "First inspect the current workspace and session state, then continue from existing artifacts if possible.",
  "Avoid repeating expensive steps unless they are truly required.",
].join("\n");

type GatewayChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type GatewayChatMessage =
  | string
  | {
      role: "user";
      content: GatewayChatContentPart[];
    };

class VoiceTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceTranscriptionError";
  }
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
  if (TRANSPORT_INTERRUPTION_PATTERNS.some((pattern) => pattern.test(message))) {
    return { retryable: true, reason: "transport_interruption" };
  }
  return { retryable: false, reason: "non_retryable" };
}

function maybeApplyTransportRecoveryNote(message: GatewayChatMessage, enabled: boolean): GatewayChatMessage {
  if (!enabled) return message;
  if (typeof message === "string") {
    const text = message.trim();
    return text ? `${text}\n\n${TRANSPORT_RECOVERY_NOTE}` : TRANSPORT_RECOVERY_NOTE;
  }

  const content = Array.isArray(message.content) ? [...message.content] : [];
  const firstTextIndex = content.findIndex((part) => part.type === "text");
  if (firstTextIndex >= 0) {
    const firstText = content[firstTextIndex];
    if (firstText?.type === "text") {
      content[firstTextIndex] = {
        type: "text",
        text: `${firstText.text}\n\n${TRANSPORT_RECOVERY_NOTE}`,
      };
      return { ...message, content };
    }
  }

  return {
    ...message,
    content: [{ type: "text", text: TRANSPORT_RECOVERY_NOTE }, ...content],
  };
}

function readLatestUserFacingMessage(events: ChatEvent[]): unknown {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const message = events[i]?.message;
    if (message !== undefined) {
      return message;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

function extractTextFromMessage(message: unknown): string | null {
  if (typeof message === "string") {
    const normalized = message.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (!isPlainObject(message)) return null;
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text.trim();
  }
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .map((part) => {
      if (typeof part === "string" && part.trim().length > 0) {
        return part.trim();
      }
      if (isPlainObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text.trim();
      }
      return null;
    })
    .filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizeComparableText(text: string | null | undefined): string {
  return (text ?? "").replace(/\r\n/g, "\n").trim();
}

function matchesTranscriptUserMessage(candidateText: string, requestText: string): boolean {
  const normalizedCandidate = normalizeComparableText(candidateText);
  const normalizedRequest = normalizeComparableText(requestText);
  if (!normalizedCandidate || !normalizedRequest) return false;
  return (
    normalizedCandidate === normalizedRequest ||
    normalizedCandidate.endsWith(normalizedRequest)
  );
}

function stripMediaDirectiveLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*MEDIA:\s*/.test(line) && !/^\s*\[\[\s*media\s*:/.test(line))
    .join("\n")
    .trim();
}

async function readSessionsMapFromState(): Promise<Record<string, unknown> | null> {
  const sessionsMapFile = path.join(resolveDefaultStateDir(), "agents", "main", "sessions", "sessions.json");
  const raw = await fs.readFile(sessionsMapFile, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  return isPlainObject(parsed) ? parsed : null;
}

function readMessageRole(message: unknown): string | null {
  if (!isPlainObject(message)) return null;
  return typeof message.role === "string" && message.role.trim().length > 0 ? message.role.trim() : null;
}

async function readLatestAssistantMessageFromSessionTranscript(input: {
  sessionKey: string;
  requestMessage: GatewayChatMessage;
}): Promise<unknown> {
  const requestText = normalizeComparableText(extractTextFromMessage(input.requestMessage));
  if (!requestText) return undefined;

  const sessionsMap = await readSessionsMapFromState();
  if (!sessionsMap) return undefined;

  const sessionEntry = sessionsMap[`agent:main:${input.sessionKey}`];
  if (!isPlainObject(sessionEntry)) return undefined;

  const rawSessionFile =
    typeof sessionEntry.sessionFile === "string" && sessionEntry.sessionFile.trim().length > 0
      ? sessionEntry.sessionFile.trim()
      : "";
  if (!rawSessionFile) return undefined;

  const sessionFile = path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(resolveDefaultStateDir(), "agents", "main", "sessions", rawSessionFile);
  const rawTranscript = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!rawTranscript.trim()) return undefined;

  const transcriptMessages = rawTranscript
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { type?: unknown; message?: unknown } => isPlainObject(entry) && entry.type === "message");

  let matchingUserIndex = -1;
  for (let i = transcriptMessages.length - 1; i >= 0; i -= 1) {
    const candidate = transcriptMessages[i]?.message;
    if (readMessageRole(candidate) !== "user") continue;
    const candidateText = extractTextFromMessage(candidate);
    if (candidateText && matchesTranscriptUserMessage(candidateText, requestText)) {
      matchingUserIndex = i;
      break;
    }
  }

  if (matchingUserIndex < 0) return undefined;

  let latestAssistantMessage: unknown = undefined;
  for (let i = matchingUserIndex + 1; i < transcriptMessages.length; i += 1) {
    const candidate = transcriptMessages[i]?.message;
    const role = readMessageRole(candidate);
    if (role === "user") break;
    if (role !== "assistant") continue;
    if (!extractTextFromMessage(candidate)) continue;
    latestAssistantMessage = candidate;
  }

  return latestAssistantMessage;
}

function shouldPreferTranscriptReplyMessage(input: {
  gatewayMessage: unknown;
  transcriptMessage: unknown;
}): boolean {
  const transcriptText = extractTextFromMessage(input.transcriptMessage);
  if (!transcriptText) return false;

  const gatewayText = extractTextFromMessage(input.gatewayMessage);
  if (!gatewayText) return true;

  const gatewayMediaPaths = [
    ...extractMediaDirectivePaths(gatewayText),
    ...extractNativeMediaDirectivePaths(gatewayText),
  ];
  const transcriptMediaPaths = [
    ...extractMediaDirectivePaths(transcriptText),
    ...extractNativeMediaDirectivePaths(transcriptText),
  ];
  if (gatewayMediaPaths.length > 0 || transcriptMediaPaths.length === 0) {
    return false;
  }

  return (
    normalizeComparableText(stripMediaDirectiveLines(gatewayText)) ===
    normalizeComparableText(stripMediaDirectiveLines(transcriptText))
  );
}

function buildAttemptIdempotencyKey(input: {
  taskId: string;
  attempt: number;
  transportRecoveryEnabled: boolean;
}): string {
  if (!input.transportRecoveryEnabled || input.attempt <= 1) {
    return input.taskId;
  }
  return `${input.taskId}:transport-recovery:${input.attempt}`;
}

function normalizeGatewayFailureMessage(input: {
  message: string;
  reason: string;
  attempts: number;
  transportRecoveryEnabled: boolean;
}): string {
  if (input.reason !== "transport_interruption") {
    return input.message;
  }
  if (input.transportRecoveryEnabled || input.attempts > 1) {
    return `The agent lost network connectivity while running tools. We retried ${input.attempts} times in the same session, but recovery did not succeed. Partial files may exist in the workspace.`;
  }
  return "The agent lost network connectivity while running tools. Partial files may exist in the workspace.";
}

function resolveDefaultStateDir(): string {
  return resolveOpenclawStateDir(process.env);
}

async function listKnownSessionKeysFromState(): Promise<string[]> {
  const parsed = await readSessionsMapFromState();
  if (!parsed) return [];

  const out: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!key.startsWith("agent:main:")) continue;
    const sessionKey = key.slice("agent:main:".length).trim();
    if (sessionKey) out.push(sessionKey);
  }
  return out;
}

export class ChatRunner {
  private waitersByRunId = new Map<string, Waiter>();
  private runSessionByRunId = new Map<string, string>();
  private runEventsByRunId = new Map<string, ChatEvent[]>();
  private runTraceByRunId = new Map<string, { backendMessageId: string }>();
  private sessionMaintenanceLock: Promise<void> | null = null;
  private readonly devLogEnabled: boolean;
  private readonly devLogTextMaxLen: number;
  private readonly retry: ChatRetryOptions;
  private readonly transcription: TranscriptionOptions;
  private readonly transcribeAudio: (input: {
    media: AudioTaskMedia;
    baseUrl: string;
    relayToken: string;
    model: string;
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
        baseUrl: string;
        relayToken: string;
        model: string;
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
      baseUrl: opts?.transcription?.baseUrl?.trim() ?? "http://localhost:3000/api/v1/relays/openai",
      relayToken: opts?.transcription?.relayToken?.trim() ?? "",
      model: opts?.transcription?.model?.trim() ?? "gpt-4o-transcribe",
      timeoutMs: Math.max(1000, Math.trunc(opts?.transcription?.timeoutMs ?? 15_000)),
    };
    this.transcribeAudio = opts?.transcribeAudio ?? transcribeAudioWithOpenAi;
  }

  handleEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvt = parsed.data;
    const events = this.runEventsByRunId.get(chatEvt.runId) ?? [];
    events.push(chatEvt);
    this.runEventsByRunId.set(chatEvt.runId, events);
    if (chatEvt.state !== "final" && chatEvt.state !== "error" && chatEvt.state !== "aborted") return;
    if (this.devLogEnabled) {
      logger.debug({ runId: chatEvt.runId, state: chatEvt.state }, "Gateway chat event terminal");
    }
    const waiter = this.waitersByRunId.get(chatEvt.runId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waitersByRunId.delete(chatEvt.runId);
    this.runSessionByRunId.delete(chatEvt.runId);
    this.runTraceByRunId.delete(chatEvt.runId);
    waiter.resolve(chatEvt);
  }

  getRunTrace(runId: string): { backendMessageId: string } | null {
    return this.runTraceByRunId.get(runId) ?? null;
  }

  async runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    media?: TaskMedia[];
    deliverySystem?: DeliverySystem;
    timeoutMs: number;
  }): Promise<{ result: ChatRunResult; openclawMeta: OpenclawChatMeta }> {
    await this.waitForSessionMaintenance();
    let baseMessageText: string;
    try {
      baseMessageText = await this.resolveMessageText(input);
    } catch (error) {
      if (error instanceof VoiceTranscriptionError) {
        return {
          result: {
            outcome: "error",
            error: {
              code: "VOICE_TRANSCRIPTION_FAILED",
              message: error.message,
            },
          },
          openclawMeta: { method: "chat.send" },
        };
      }
      throw error;
    }
    baseMessageText = applyTransportDeliveryInstructions({
      sessionKey: input.sessionKey,
      messageText: baseMessageText,
      deliverySystem: input.deliverySystem ?? "legacy_push_v1",
    });
    const gatewayMessage = await buildGatewayChatMessage({
      messageText: baseMessageText,
      media: input.media,
    });
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
          textLen: summarizeOutgoingMessageLength(gatewayMessage.primary),
          textPreview: summarizeOutgoingMessagePreview(gatewayMessage.primary, this.devLogTextMaxLen),
        },
        "Message flow transition"
      );
    }
    let transportRecoveryEnabled = false;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt += 1) {
      let finalAttemptMessage: GatewayChatMessage | null = null;
      const elapsedMs = Date.now() - startedAtMs;
      const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
      if (remainingMs < 300) {
        return {
          result: {
            outcome: "error",
            error: { code: "GATEWAY_TIMEOUT", message: "Timed out waiting for final" },
          },
          openclawMeta: { method: "chat.send" },
        };
      }

      // Keep the same idempotency key for blind retries. Recovery retries after a
      // terminal transport interruption intentionally use a new key because we send
      // a new recovery note in the same session.
      let runId: string | null = null;
      try {
        const attemptMessage = maybeApplyTransportRecoveryNote(
          gatewayMessage.primary,
          transportRecoveryEnabled && attempt > 1
        );
        finalAttemptMessage = attemptMessage;
        const idempotencyKey = buildAttemptIdempotencyKey({
          taskId: input.taskId,
          attempt,
          transportRecoveryEnabled,
        });
        const payload = await this.gateway.request("chat.send", {
          sessionKey: input.sessionKey,
          message: attemptMessage,
          idempotencyKey,
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
            openclawMeta: { method: "chat.send" },
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (gatewayMessage.fallback && shouldFallbackToUploadedFiles(err)) {
          logger.warn(
            {
              taskId: input.taskId,
              sessionKey: input.sessionKey,
              error: msg,
            },
            "Gateway rejected multimodal payload; retrying with uploaded files fallback"
          );
          gatewayMessage.primary = gatewayMessage.fallback;
          gatewayMessage.fallback = null;
          attempt -= 1;
          continue;
        }
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
          const normalizedMessage =
            transportRecoveryEnabled && this.retry.attempts > 1
              ? "The agent lost network connectivity while attempting to recover the interrupted run. Partial files may exist in the workspace."
              : `Gateway request failed: ${msg}`;
          return {
            result: { outcome: "error", error: { code: "GATEWAY_ERROR", message: normalizedMessage } },
            openclawMeta: { method: "chat.send" },
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
        this.runTraceByRunId.set(runId, { backendMessageId: input.taskId });
        if (!this.runEventsByRunId.has(runId)) {
          this.runEventsByRunId.set(runId, []);
        }
        const finalEvt = await this.waitForFinal(runId, remainingMs);
        this.runSessionByRunId.delete(runId);
        this.runTraceByRunId.delete(runId);
        const openclawEvents = this.consumeRunEvents(runId);
        if (finalEvt.state === "final") {
          const gatewayFinalMessage = finalEvt.message ?? readLatestUserFacingMessage(openclawEvents);
          const transcriptFinalMessage =
            finalAttemptMessage !== null
              ? await readLatestAssistantMessageFromSessionTranscript({
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage,
                }).catch(() => undefined)
              : undefined;
          const useTranscriptFinalMessage =
            transcriptFinalMessage !== undefined &&
            shouldPreferTranscriptReplyMessage({
              gatewayMessage: gatewayFinalMessage,
              transcriptMessage: transcriptFinalMessage,
            });
          const finalMessage =
            gatewayFinalMessage !== undefined && !useTranscriptFinalMessage
              ? gatewayFinalMessage
              : transcriptFinalMessage;
          if (useTranscriptFinalMessage) {
            logger.info(
              {
                event: "artifact_delivery",
                stage: "transcript_reply_recovered",
                taskId: input.taskId,
                openclawRunId: runId,
                sessionKey: input.sessionKey,
              },
              "Recovered final reply message from session transcript"
            );
          }
          if (finalMessage !== undefined) {
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
            let artifactResolution = await collectTranscriptArtifacts({
              message: finalMessage,
              openclawEvents,
              opts: {
                logContext: {
                  taskId: input.taskId,
                  runId,
                  sessionKey: input.sessionKey,
                },
              },
            }).catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              logger.warn(
                { taskId: input.taskId, runId, err: message },
                "Failed to collect transcript artifacts"
              );
              return {
                artifacts: [],
                unresolved: [
                  {
                    source: "structured_artifact",
                    reason: "collection_failed",
                    fileName: "artifact-resolution",
                    candidatePaths: [message],
                  },
                ],
                requestedCount: 1,
                recoveredCount: 0,
                usedStructuredArtifacts: false,
                usedLegacyMediaDirectives: false,
              } satisfies TranscriptArtifactCollectionReport;
            });
            if (
              (input.deliverySystem ?? "legacy_push_v1") !== "relay_channel_v2" &&
              artifactResolution.requestedCount === 0 &&
              transcriptFinalMessage !== undefined &&
              transcriptFinalMessage !== finalMessage
            ) {
              const transcriptArtifactResolution = await collectTranscriptArtifacts({
                message: transcriptFinalMessage,
                openclawEvents,
                opts: {
                  logContext: {
                    taskId: input.taskId,
                    runId,
                    sessionKey: input.sessionKey,
                  },
                },
              }).catch(() => null);
              if (
                transcriptArtifactResolution &&
                transcriptArtifactResolution.requestedCount > 0
              ) {
                artifactResolution = transcriptArtifactResolution;
                logger.info(
                  {
                    event: "artifact_delivery",
                    stage: "transcript_artifacts_recovered",
                    taskId: input.taskId,
                    openclawRunId: runId,
                    sessionKey: input.sessionKey,
                    requestedCount: transcriptArtifactResolution.requestedCount,
                    resolvedCount: transcriptArtifactResolution.artifacts.length,
                    unresolvedCount: transcriptArtifactResolution.unresolved.length,
                  },
                  "Recovered reply artifacts from session transcript"
                );
              }
            }
            const media = artifactResolution.artifacts.map((artifact) => ({
              path: artifact.path,
              fileName: artifact.fileName,
              contentType: artifact.contentType,
              sizeBytes: artifact.sizeBytes,
            }));
            logger.info(
              {
                event: "artifact_delivery",
                stage: "artifact_collection_completed",
                taskId: input.taskId,
                openclawRunId: runId,
                sessionKey: input.sessionKey,
                requestedCount: artifactResolution.requestedCount,
                resolvedCount: artifactResolution.artifacts.length,
                unresolvedCount: artifactResolution.unresolved.length,
                recoveredCount: artifactResolution.recoveredCount,
                usedStructuredArtifacts: artifactResolution.usedStructuredArtifacts,
                usedLegacyMediaDirectives: artifactResolution.usedLegacyMediaDirectives,
              },
              "Transcript artifact collection completed"
            );
            return {
              result: {
                outcome: "reply",
                reply: {
                  message: finalMessage,
                  runId,
                  ...(artifactResolution.artifacts.length > 0
                    ? { artifacts: artifactResolution.artifacts }
                    : {}),
                  ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
                  ...(media.length > 0 ? { media } : {}),
                  ...(artifactResolution.requestedCount > 0
                    ? { artifactResolution }
                    : {}),
                },
              },
              openclawMeta: {
                method: "chat.send",
                runId,
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
            result: {
              outcome: "error",
              error: {
                code: "NO_MESSAGE",
                message: "OpenClaw completed without a user-facing message",
                ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
              },
            },
            openclawMeta: {
              method: "chat.send",
              runId,
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
            result: {
              outcome: "error",
              error: {
                code: "ABORTED",
                message: "Chat aborted",
                runId,
                ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
              },
            },
            openclawMeta: {
              method: "chat.send",
              runId,
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
          const normalizedMessage = normalizeGatewayFailureMessage({
            message: gatewayErrorMessage,
            reason: classification.reason,
            attempts: attempt,
            transportRecoveryEnabled,
          });
          return {
            result: {
              outcome: "error",
              error: {
                code: "GATEWAY_ERROR",
                message: normalizedMessage,
                runId,
                ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
              },
            },
            openclawMeta: {
              method: "chat.send",
              runId,
            },
          };
        }
        if (classification.reason === "transport_interruption") {
          transportRecoveryEnabled = true;
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
        this.runTraceByRunId.delete(runId);
        this.runEventsByRunId.delete(runId);
        const msg = err instanceof Error ? err.message : "Timed out waiting for final";
        const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
        const retryable = attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
        if (!retryable) {
          return {
            result: { outcome: "error", error: { code: "GATEWAY_TIMEOUT", message: msg, runId } },
            openclawMeta: { method: "chat.send", runId },
          };
        }
        await sleep(backoffMs);
      }
    }

    // Should be unreachable due to loop returns, but keep a safe fallback.
    return {
      result: { outcome: "error", error: { code: "GATEWAY_ERROR", message: "Chat failed" } },
      openclawMeta: { method: "chat.send" },
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
          this.runTraceByRunId.set(runId, { backendMessageId: `session_new:${sessionKey}` });
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
            this.runTraceByRunId.delete(runId);
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

    try {
      const transcript = await this.transcribeAudio({
        media,
        baseUrl: this.transcription.baseUrl,
        relayToken: this.transcription.relayToken,
        model: this.transcription.model,
        timeoutMs: this.transcription.timeoutMs,
      });
      return composeMessageWithTranscript({ messageText: input.messageText, transcript });
    } catch (error) {
      logTranscriptionFailure({ taskId: input.taskId, error });
      const reason = error instanceof Error ? error.message.trim() : String(error);
      throw new VoiceTranscriptionError(
        `Voice message could not be transcribed, so it was not sent to the model. ${reason}`
      );
    }
  }

  private waitForFinal(runId: string, timeoutMs: number): Promise<ChatEvent> {
    return new Promise<ChatEvent>((resolve, reject) => {
      const pendingTerminalEvent = (this.runEventsByRunId.get(runId) ?? []).find(
        (event) => event.state === "final" || event.state === "error" || event.state === "aborted"
      );
      if (pendingTerminalEvent) {
        resolve(pendingTerminalEvent);
        return;
      }
      const timeout = setTimeout(() => {
        this.waitersByRunId.delete(runId);
        this.runSessionByRunId.delete(runId);
        this.runTraceByRunId.delete(runId);
        this.runEventsByRunId.delete(runId);
        reject(new Error("Timed out waiting for final"));
      }, timeoutMs);
      this.waitersByRunId.set(runId, { resolve, reject, timeout });
    });
  }

  private consumeRunEvents(runId: string): ChatEvent[] {
    const events = this.runEventsByRunId.get(runId) ?? [];
    this.runEventsByRunId.delete(runId);
    return events;
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

}

function composeMessageWithUploadedFiles(messageText: string, uploadedPaths: string[]): string {
  if (!Array.isArray(uploadedPaths) || uploadedPaths.length === 0) return messageText;
  const suffix = uploadedPaths.map((filePath) => `File uploaded to: ${filePath}`).join("\n");
  const text = messageText.trim();
  return text ? `${text}\n${suffix}` : suffix;
}

async function buildGatewayChatMessage(input: {
  messageText: string;
  media?: TaskMedia[];
}): Promise<{ primary: GatewayChatMessage; fallback: GatewayChatMessage | null }> {
  const prepared = await prepareChatMedia({
    messageText: input.messageText,
    media: input.media,
  });
  const imageMedia = prepared.visionMedia;
  const uploadedPaths = await saveUploadedFiles({ media: prepared.uploadMedia });
  const messageText = composeMessageWithUploadedFiles(prepared.messageText, uploadedPaths);
  if (imageMedia.length === 0) {
    return { primary: messageText, fallback: null };
  }

  const directText = normalizeVisionPromptText(messageText);
  const content: GatewayChatContentPart[] = [{ type: "text", text: directText }];
  for (const image of imageMedia) {
    content.push({
      type: "image_url",
      image_url: {
        url: toImageDataUrl(image),
      },
    });
  }

  const fallbackImagePaths = await saveUploadedFiles({
    media: prepared.uploadMedia,
    includeTypes: ["image"],
  });
  const fallbackText = composeMessageWithUploadedFiles(normalizeVisionPromptText(prepared.messageText), [
    ...uploadedPaths,
    ...fallbackImagePaths,
  ]);

  return {
    primary: {
      role: "user",
      content,
    },
    fallback: normalizeVisionPromptText(fallbackText),
  };
}

function normalizeVisionPromptText(messageText: string): string {
  const text = messageText.trim();
  return text.length > 0 ? text : "[image]";
}

function applyTransportDeliveryInstructions(input: {
  sessionKey: string;
  messageText: string;
  deliverySystem: DeliverySystem;
}): string {
  const isTelegramSession = input.sessionKey.startsWith("tg:");
  const isWhatsAppPersonalSession = input.sessionKey.startsWith("whatsapp-personal:");
  if (!isTelegramSession && !isWhatsAppPersonalSession) {
    return input.messageText;
  }
  const transportLabel = isTelegramSession ? "Telegram" : "WhatsApp Personal";
  const instruction = [
    `[${transportLabel} ${input.deliverySystem === "relay_channel_v2" ? "plugin" : "bridge"} note]`,
    `If you need to send the user a file, first save or locate the exact file inside the ${
      input.deliverySystem === "relay_channel_v2" ? "current workspace" : "OpenClaw workspace"
    }.`,
    `Before replying, verify that the file really exists at that exact ${
      input.deliverySystem === "relay_channel_v2" ? "local" : "workspace-relative"
    } path.`,
    "In your final answer, add a separate final token exactly as `[[media:relative/path.ext]]`.",
    "Use the real path only. Do not invent directories, rename the file inside the directive, or point to an approximate match.",
    "If you need to send multiple files, add one separate `[[media:...]]` directive per file.",
    "If you are not sure about the exact path, inspect the workspace first and only then reply.",
    "Do not paste the full file contents into the reply when the intended output is a file attachment.",
  ].join("\n");
  const text = input.messageText.trim();
  return text ? `${text}\n\n${instruction}` : instruction;
}

function toImageDataUrl(image: ImageTaskMedia): string {
  const mime = image.contentType.trim() || "application/octet-stream";
  return `data:${mime};base64,${image.dataB64}`;
}

function summarizeOutgoingMessageLength(message: GatewayChatMessage): number {
  if (typeof message === "string") return message.length;
  return JSON.stringify(message).length;
}

function summarizeOutgoingMessagePreview(message: GatewayChatMessage, textMaxLen: number): string {
  if (typeof message === "string") return makeTextPreview(message, textMaxLen);
  const content = Array.isArray(message.content) ? message.content : [];
  const textParts = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text);
  const imageCount = content.filter((part) => part.type === "image_url").length;
  const textPreview = makeTextPreview(textParts.join("\n"), textMaxLen);
  return imageCount > 0 ? `${textPreview} [images:${imageCount}]` : textPreview;
}

function shouldFallbackToUploadedFiles(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalized = error.message.toLowerCase();
  return (
    normalized.includes("validation") ||
    normalized.includes("invalid") ||
    normalized.includes("bad request") ||
    normalized.includes("unsupported") ||
    normalized.includes("params")
  );
}

function extractRunId(payload: unknown): string | null {
  // OpenClaw chat.send typically returns { runId, ... }.
  if (!payload || typeof payload !== "object") return null;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

