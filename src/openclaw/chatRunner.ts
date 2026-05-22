import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import type {
  TranscriptArtifact,
  TranscriptArtifactCollectionReport,
  TranscriptMediaFile,
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
  resolve: (evt: ChatCompletionSignal) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  onActivity?: (activity: ChatRunActivity) => void;
  minEventSeq?: number;
  ignoreFinalWithoutUserFacingMessage?: boolean;
  allowUserFacingDeltaCompletion?: boolean;
  transcriptPoll?: NodeJS.Timeout;
  transcriptPolling?: boolean;
  transcriptCandidateKey?: string;
  transcriptCandidateFirstSeenAtMs?: number;
};

type ChatCompletionSignal =
  | ChatEvent
  | {
      state: "transcript";
      message: unknown;
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

export type ChatRunActivity = {
  runId: string;
  state: ChatEvent["state"] | "transcript";
  observedAtMs: number;
};

type DeliverySystem = "relay_channel_v2";

export type ChatSendOriginRoute = {
  originatingChannel: string;
  originatingTo: string;
  originatingAccountId?: string;
  originatingThreadId?: string;
};

type ResolvedSessionTranscriptState = {
  sessionFile: string;
  baselineLineCount?: number;
};

const TRANSPORT_INTERRUPTION_PATTERNS = [
  /network connection lost/i,
  /socket hang up/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\beconnaborted\b/i,
  /\betimedout\b/i,
  /stream ended unexpectedly/i,
  /connection closed/i,
  /gateway closed/i,
  /gateway connection lost/i,
  /handshake timed out/i,
  /upstream disconnected/i,
] as const;

const TRANSPORT_RECOVERY_NOTE = [
  "[System note]",
  "The previous attempt ended due to a network interruption after partial tool execution.",
  "First inspect the current workspace and session state, then continue from existing artifacts if possible.",
  "Avoid repeating expensive steps unless they are truly required.",
].join("\n");

const OPENCLAW_SLASH_COMMAND_FINAL_WAIT_TIMEOUT_MS = 15_000;
const OPENCLAW_ERROR_TRANSCRIPT_RECOVERY_TIMEOUT_MS = 10_000;
const OPENCLAW_DISCONNECT_TRANSCRIPT_RECOVERY_TIMEOUT_MS = 1_500;
const OPENCLAW_ERROR_TRANSCRIPT_RECOVERY_POLL_INTERVAL_MS = 250;
const OPENCLAW_EMPTY_FINAL_CONTINUATION_TIMEOUT_MS = 10 * 60_000;
const OPENCLAW_TRANSCRIPT_FINAL_STABILITY_MS = 1_000;
const OPENCLAW_RUN_TRACE_RETENTION_MS = 60_000;

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

class GatewayRunDisconnectedError extends Error {
  constructor(
    readonly runId: string,
    reason?: string,
  ) {
    super(
      reason
        ? `Gateway connection lost while waiting for run ${runId}: ${reason}`
        : `Gateway connection lost while waiting for run ${runId}`
    );
    this.name = "GatewayRunDisconnectedError";
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
    if (message !== undefined && extractTextFromMessage(message)) {
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

function messageContainsToolActivity(message: unknown): boolean {
  if (!isPlainObject(message)) return false;
  if (typeof message.toolCallId === "string" || typeof message.tool_call_id === "string") return true;
  if (typeof message.toolName === "string" || typeof message.tool_name === "string") return true;
  if (Array.isArray(message.toolCalls) || Array.isArray(message.tool_calls)) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!isPlainObject(part)) return false;
    const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
    if (
      type === "toolcall" ||
      type === "tool_call" ||
      type === "tool_use" ||
      type === "function_call" ||
      type === "toolresult" ||
      type === "tool_result"
    ) {
      return true;
    }
    return (
      typeof part.toolCallId === "string" ||
      typeof part.tool_call_id === "string" ||
      typeof part.name === "string" && (typeof part.arguments === "object" || typeof part.arguments === "string")
    );
  });
}

function buildTranscriptCandidateKey(message: unknown): string {
  return JSON.stringify(message);
}

function normalizeComparableText(text: string | null | undefined): string {
  return (text ?? "").replace(/\r\n/g, "\n").trim();
}

function stripTranscriptDeliveryDecorations(text: string): string {
  return text
    .replace(/^Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i, "")
    .replace(/^\[[^\]\n]+UTC\]\s+[^:\n]{1,120}:\s*/gim, "")
    .replace(/^\[part\s+\d+\/\d+\]\s*/gim, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collapseComparableWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function matchesTranscriptUserMessage(candidateText: string, requestText: string): boolean {
  const normalizedCandidate = normalizeComparableText(candidateText);
  const normalizedRequest = normalizeComparableText(requestText);
  if (!normalizedCandidate || !normalizedRequest) return false;
  if (normalizedCandidate === normalizedRequest || normalizedCandidate.endsWith(normalizedRequest)) {
    return true;
  }

  const canonicalCandidate = stripTranscriptDeliveryDecorations(normalizedCandidate);
  const canonicalRequest = stripTranscriptDeliveryDecorations(normalizedRequest);
  if (!canonicalCandidate || !canonicalRequest) return false;
  if (canonicalCandidate === canonicalRequest || canonicalCandidate.endsWith(canonicalRequest)) {
    return true;
  }

  const compactCandidate = collapseComparableWhitespace(canonicalCandidate);
  const compactRequest = collapseComparableWhitespace(canonicalRequest);
  if (!compactCandidate || !compactRequest) return false;
  if (compactCandidate === compactRequest || compactCandidate.endsWith(compactRequest)) {
    return true;
  }

  const allowContainedMatch = Math.max(compactCandidate.length, compactRequest.length) >= 200;
  if (!allowContainedMatch) {
    return false;
  }
  const anchorLength = Math.min(160, compactRequest.length, compactCandidate.length);
  const requestPrefix = compactRequest.slice(0, anchorLength);
  const requestSuffix = compactRequest.slice(-anchorLength);
  return (
    compactCandidate.includes(compactRequest) ||
    compactRequest.includes(compactCandidate) ||
    (requestPrefix.length >= 80 &&
      requestSuffix.length >= 80 &&
      compactCandidate.includes(requestPrefix) &&
      compactCandidate.includes(requestSuffix))
  );
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

function resolveSessionTranscriptStateFromMap(input: {
  sessionsMap: Record<string, unknown>;
  sessionKey: string;
}): ResolvedSessionTranscriptState | null {
  const sessionEntry = input.sessionsMap[`agent:main:${input.sessionKey}`];
  if (!isPlainObject(sessionEntry)) return null;

  const rawSessionFile =
    typeof sessionEntry.sessionFile === "string" && sessionEntry.sessionFile.trim().length > 0
      ? sessionEntry.sessionFile.trim()
      : "";
  if (!rawSessionFile) return null;

  return {
    sessionFile: path.isAbsolute(rawSessionFile)
      ? rawSessionFile
      : path.join(resolveDefaultStateDir(), "agents", "main", "sessions", rawSessionFile),
  };
}

async function waitForSessionTranscriptState(input: {
  sessionKey: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<ResolvedSessionTranscriptState | null> {
  if (input.timeoutMs <= 0) {
    return null;
  }
  const deadline = Date.now() + input.timeoutMs;
  const pollIntervalMs = Math.max(50, Math.trunc(input.pollIntervalMs ?? 100));
  while (Date.now() < deadline) {
    const sessionsMap = await readSessionsMapFromState();
    if (sessionsMap) {
      const resolved = resolveSessionTranscriptStateFromMap({
        sessionsMap,
        sessionKey: input.sessionKey,
      });
      if (resolved) {
        const hasSessionFile = await fs
          .access(resolved.sessionFile)
          .then(() => true)
          .catch(() => false);
        if (hasSessionFile) {
          return resolved;
        }
      }
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return null;
}

async function readSessionTranscriptLineCount(sessionFile: string): Promise<number> {
  const rawTranscript = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!rawTranscript.trim()) return 0;
  return rawTranscript.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function readExistingSessionTranscriptState(input: {
  sessionKey: string;
}): Promise<ResolvedSessionTranscriptState | null> {
  const sessionsMap = await readSessionsMapFromState();
  if (!sessionsMap) return null;
  const sessionState = resolveSessionTranscriptStateFromMap({
    sessionsMap,
    sessionKey: input.sessionKey,
  });
  if (!sessionState) return null;
  const hasSessionFile = await fs
    .access(sessionState.sessionFile)
    .then(() => true)
    .catch(() => false);
  if (!hasSessionFile) return null;
  return {
    ...sessionState,
    baselineLineCount: await readSessionTranscriptLineCount(sessionState.sessionFile),
  };
}

function readMessageRole(message: unknown): string | null {
  if (!isPlainObject(message)) return null;
  return typeof message.role === "string" && message.role.trim().length > 0 ? message.role.trim() : null;
}

async function readLatestAssistantMessageFromSessionTranscript(input: {
  sessionKey: string;
  requestMessage: GatewayChatMessage;
  sessionState?: ResolvedSessionTranscriptState | null;
}): Promise<unknown> {
  const requestText = normalizeComparableText(extractTextFromMessage(input.requestMessage));
  if (!requestText) return undefined;

  const sessionsMap = input.sessionState ? null : await readSessionsMapFromState();
  const sessionState =
    input.sessionState ??
    (sessionsMap
      ? resolveSessionTranscriptStateFromMap({
          sessionsMap,
          sessionKey: input.sessionKey,
        })
      : null);
  if (!sessionState) return undefined;

  const rawTranscript = await fs.readFile(sessionState.sessionFile, "utf8").catch(() => "");
  if (!rawTranscript.trim()) return undefined;

  const transcriptLines = rawTranscript
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const transcriptMessages = transcriptLines
    .slice(Math.max(0, Math.trunc(input.sessionState?.baselineLineCount ?? 0)))
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
    if (messageContainsToolActivity(candidate)) continue;
    if (!extractTextFromMessage(candidate)) continue;
    latestAssistantMessage = candidate;
  }

  return latestAssistantMessage;
}

async function waitForAssistantMessageFromSessionTranscript(input: {
  sessionKey: string;
  requestMessage: GatewayChatMessage;
  timeoutMs: number;
  pollIntervalMs?: number;
  sessionState?: ResolvedSessionTranscriptState | null;
}): Promise<unknown> {
  const deadline = Date.now() + input.timeoutMs;
  const pollIntervalMs = Math.max(50, Math.trunc(input.pollIntervalMs ?? OPENCLAW_ERROR_TRANSCRIPT_RECOVERY_POLL_INTERVAL_MS));
  while (Date.now() < deadline) {
    const transcriptMessage = await readLatestAssistantMessageFromSessionTranscript({
      sessionKey: input.sessionKey,
      requestMessage: input.requestMessage,
      sessionState: input.sessionState,
    }).catch(() => undefined);
    if (transcriptMessage !== undefined) {
      return transcriptMessage;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
  return undefined;
}

function collectReplyArtifacts(input: {
  taskId: string;
  runId: string;
  sessionKey: string;
  deliverySystem: DeliverySystem;
  finalMessage: unknown;
  transcriptFinalMessage?: unknown;
  openclawEvents: ChatEvent[];
}): {
  artifacts: TranscriptArtifact[];
  media: TranscriptMediaFile[];
  artifactResolution?: TranscriptArtifactCollectionReport;
} {
  void input.deliverySystem;
  void input.finalMessage;
  void input.transcriptFinalMessage;
  void input.openclawEvents;
  const artifactResolution: TranscriptArtifactCollectionReport = {
    artifacts: [],
    unresolved: [],
    requestedCount: 0,
    recoveredCount: 0,
    usedStructuredArtifacts: false,
    usedLegacyMediaDirectives: false,
  };
  logger.info(
    {
      event: "artifact_delivery",
      stage: "artifact_collection_completed",
      taskId: input.taskId,
      openclawRunId: input.runId,
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
    artifacts: [],
    media: [],
  };
}

async function buildReplyRunResult(input: {
  taskId: string;
  runId: string;
  sessionKey: string;
  deliverySystem: DeliverySystem;
  finalMessage: unknown;
  transcriptFinalMessage?: unknown;
  openclawEvents: ChatEvent[];
  startedAtMs: number;
  devLogEnabled: boolean;
}): Promise<{
  result: ChatRunResult;
  openclawMeta: OpenclawChatMeta;
}> {
  await Promise.resolve();
  if (input.devLogEnabled) {
    logger.info(
      {
        event: "message_flow",
        direction: "openclaw_to_relay",
        stage: "response_received",
        backendMessageId: input.taskId,
        relayMessageId: null,
        openclawRunId: input.runId,
        outcome: "reply",
        durationMs: Date.now() - input.startedAtMs,
      },
      "Message flow transition"
    );
  }
  const artifactDelivery = collectReplyArtifacts({
    taskId: input.taskId,
    runId: input.runId,
    sessionKey: input.sessionKey,
    deliverySystem: input.deliverySystem,
    finalMessage: input.finalMessage,
    transcriptFinalMessage: input.transcriptFinalMessage,
    openclawEvents: input.openclawEvents,
  });
  return {
    result: {
      outcome: "reply",
      reply: {
        message: input.finalMessage,
        runId: input.runId,
        ...(artifactDelivery.artifacts.length > 0 ? { artifacts: artifactDelivery.artifacts } : {}),
        ...(input.openclawEvents.length > 0 ? { openclawEvents: input.openclawEvents } : {}),
        ...(artifactDelivery.media.length > 0 ? { media: artifactDelivery.media } : {}),
        ...(artifactDelivery.artifactResolution ? { artifactResolution: artifactDelivery.artifactResolution } : {}),
      },
    },
    openclawMeta: {
      method: "chat.send",
      runId: input.runId,
    },
  };
}

function shouldPreferTranscriptReplyMessage(input: {
  gatewayMessage: unknown;
  transcriptMessage: unknown;
}): boolean {
  const transcriptText = extractTextFromMessage(input.transcriptMessage);
  if (!transcriptText) return false;

  const gatewayText = extractTextFromMessage(input.gatewayMessage);
  return !gatewayText;
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
  private runTraceCleanupTimersByRunId = new Map<string, NodeJS.Timeout>();
  private activeRunByTaskId = new Map<string, { runId: string; sessionKey: string }>();
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
      onRunCompleted?: (runId: string, reason: string) => void;
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
    this.onRunCompleted = opts?.onRunCompleted;
  }

  private readonly onRunCompleted?: (runId: string, reason: string) => void;

  handleGatewayConnectionStateChange(state: {
    connected: boolean;
    reason?: string;
    observedAtMs: number;
  }): void {
    if (state.connected || this.waitersByRunId.size === 0) {
      return;
    }
    if (this.devLogEnabled) {
      logger.warn(
        {
          activeRuns: Array.from(this.waitersByRunId.keys()),
          reason: state.reason,
          observedAtMs: state.observedAtMs,
        },
        "Rejecting active chat waiters after gateway disconnect"
      );
    }
    for (const runId of Array.from(this.waitersByRunId.keys())) {
      this.rejectRunWaiter(runId, new GatewayRunDisconnectedError(runId, state.reason));
    }
  }

  handleEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvt = parsed.data;
    const events = this.runEventsByRunId.get(chatEvt.runId) ?? [];
    events.push(chatEvt);
    this.runEventsByRunId.set(chatEvt.runId, events);
    const waiter = this.waitersByRunId.get(chatEvt.runId);
    if (!waiter) return;
    if (waiter.minEventSeq !== undefined && chatEvt.seq <= waiter.minEventSeq) {
      return;
    }
    waiter.onActivity?.({
      runId: chatEvt.runId,
      state: chatEvt.state,
      observedAtMs: Date.now(),
    });
    if (chatEvt.state === "delta") {
      if (waiter.allowUserFacingDeltaCompletion && extractTextFromMessage(chatEvt.message)) {
        waiter.resolve(chatEvt);
      }
      return;
    }
    if (chatEvt.state !== "final" && chatEvt.state !== "error" && chatEvt.state !== "aborted") return;
    if (
      waiter.ignoreFinalWithoutUserFacingMessage &&
      chatEvt.state === "final" &&
      !extractTextFromMessage(chatEvt.message) &&
      !readLatestUserFacingMessage(events)
    ) {
      return;
    }
    if (this.devLogEnabled) {
      logger.debug({ runId: chatEvt.runId, state: chatEvt.state }, "Gateway chat event terminal");
    }
    waiter.resolve(chatEvt);
  }

  getRunTrace(runId: string): { backendMessageId: string } | null {
    return this.runTraceByRunId.get(runId) ?? null;
  }

  closeRunForwarding(runId: string, reason: string): void {
    this.onRunCompleted?.(runId, reason);
  }

  async abortTask(taskId: string, reason: string): Promise<boolean> {
    const active = this.activeRunByTaskId.get(taskId);
    if (!active) {
      return false;
    }
    try {
      await Promise.race([
        this.gateway.request(
          "chat.abort",
          { sessionKey: active.sessionKey, runId: active.runId },
          { timeoutMs: 2_000 }
        ),
        sleep(2_500),
      ]);
    } catch (error) {
      if (this.devLogEnabled) {
        logger.warn(
          {
            taskId,
            runId: active.runId,
            sessionKey: active.sessionKey,
            reason,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to abort active OpenClaw chat task"
        );
      }
    }
    return true;
  }

  private registerRunTrace(runId: string, input: { sessionKey: string; backendMessageId: string }): void {
    this.clearRunTraceCleanupTimer(runId);
    this.runSessionByRunId.set(runId, input.sessionKey);
    this.runTraceByRunId.set(runId, { backendMessageId: input.backendMessageId });
    if (!this.runEventsByRunId.has(runId)) {
      this.runEventsByRunId.set(runId, []);
    }
  }

  private clearRunTraceCleanupTimer(runId: string): void {
    const timer = this.runTraceCleanupTimersByRunId.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.runTraceCleanupTimersByRunId.delete(runId);
  }

  private scheduleRunTraceCleanup(runId: string, reason: string): void {
    this.runSessionByRunId.delete(runId);
    this.clearRunTraceCleanupTimer(runId);
    const timer = setTimeout(() => {
      this.runTraceByRunId.delete(runId);
      this.runTraceCleanupTimersByRunId.delete(runId);
      if (this.devLogEnabled) {
        logger.debug({ runId, reason }, "Released retained OpenClaw run trace");
      }
    }, OPENCLAW_RUN_TRACE_RETENTION_MS);
    timer.unref?.();
    this.runTraceCleanupTimersByRunId.set(runId, timer);
  }

  async runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    media?: TaskMedia[];
    context?: unknown;
    deliverySystem?: DeliverySystem;
    originRoute?: ChatSendOriginRoute | null;
    timeoutMs: number;
    onActivity?: (activity: ChatRunActivity) => void;
  }): Promise<{ result: ChatRunResult; openclawMeta: OpenclawChatMeta }> {
    try {
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
    const deliverySystem = input.deliverySystem ?? "relay_channel_v2";
    const shouldUseSessionTranscript = isTransportBackedSession(input.sessionKey);
    const preRunTranscriptSessionState = shouldUseSessionTranscript
      ? await readExistingSessionTranscriptState({
          sessionKey: input.sessionKey,
        }).catch(() => null)
      : null;
    const isSlashCommand = isOpenclawSlashCommand(baseMessageText);
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
          ...(input.originRoute ?? {}),
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
        this.registerRunTrace(runId, { sessionKey: input.sessionKey, backendMessageId: input.taskId });
        this.activeRunByTaskId.set(input.taskId, { runId, sessionKey: input.sessionKey });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const classification = classifyRetryableGatewayError(msg);
        if (classification.reason === "transport_interruption") {
          transportRecoveryEnabled = true;
        }
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
            classification.reason === "transport_interruption"
              ? normalizeGatewayFailureMessage({
                  message: msg,
                  reason: classification.reason,
                  attempts: attempt,
                  transportRecoveryEnabled,
                })
              : transportRecoveryEnabled && this.retry.attempts > 1
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

      let transcriptSessionState: ResolvedSessionTranscriptState | null = preRunTranscriptSessionState;
      try {
        if (this.devLogEnabled) {
          logger.debug({ taskId: input.taskId, runId, attempt }, "Relay waiting for chat final event");
        }
        transcriptSessionState =
          shouldUseSessionTranscript && !transcriptSessionState
            ? await waitForSessionTranscriptState({
                sessionKey: input.sessionKey,
                timeoutMs: Math.min(1_200, Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))),
              }).catch(() => null)
            : transcriptSessionState;
        const finalWaitTimeoutMs = isSlashCommand
          ? Math.min(remainingMs, OPENCLAW_SLASH_COMMAND_FINAL_WAIT_TIMEOUT_MS)
          : remainingMs;
        const finalEvt = await this.waitForFinal(runId, finalWaitTimeoutMs, {
          sessionKey: input.sessionKey,
          requestMessage: finalAttemptMessage ?? undefined,
          sessionState: transcriptSessionState,
          allowTranscriptCompletion: true,
          ignoreFinalWithoutUserFacingMessage: true,
          onActivity: input.onActivity,
        });
        let openclawEvents = this.consumeRunEvents(runId);
        if (finalEvt.state === "transcript") {
          this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
          logger.info(
            {
              event: "artifact_delivery",
              stage: "transcript_reply_detected",
              taskId: input.taskId,
              openclawRunId: runId,
              sessionKey: input.sessionKey,
            },
            "Detected final reply directly from session transcript"
          );
          return await buildReplyRunResult({
            taskId: input.taskId,
            runId,
            sessionKey: input.sessionKey,
            deliverySystem,
            finalMessage: finalEvt.message,
            transcriptFinalMessage: finalEvt.message,
            openclawEvents,
            startedAtMs,
            devLogEnabled: this.devLogEnabled,
          });
        }
        if (finalEvt.state === "final") {
          const gatewayFinalMessage = finalEvt.message ?? readLatestUserFacingMessage(openclawEvents);
          let transcriptFinalMessage =
            finalAttemptMessage !== null
              ? await readLatestAssistantMessageFromSessionTranscript({
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage,
                  sessionState: transcriptSessionState,
                }).catch(() => undefined)
              : undefined;
          if (
            transcriptFinalMessage === undefined &&
            gatewayFinalMessage === undefined &&
            finalAttemptMessage !== null
          ) {
            transcriptFinalMessage = await waitForAssistantMessageFromSessionTranscript({
              sessionKey: input.sessionKey,
              requestMessage: finalAttemptMessage,
              timeoutMs: Math.min(1_000, Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))),
              sessionState: transcriptSessionState,
            }).catch(() => undefined);
          }
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
            this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
            return await buildReplyRunResult({
              taskId: input.taskId,
              runId,
              sessionKey: input.sessionKey,
              deliverySystem,
              finalMessage,
              transcriptFinalMessage,
              openclawEvents,
              startedAtMs,
              devLogEnabled: this.devLogEnabled,
            });
          }
          const continuationTimeoutMs = Math.min(
            OPENCLAW_EMPTY_FINAL_CONTINUATION_TIMEOUT_MS,
            Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))
          );
          const continuationEvt =
            continuationTimeoutMs > 0
              ? await this.waitForFinal(runId, continuationTimeoutMs, {
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage ?? undefined,
                  sessionState: transcriptSessionState,
                  allowTranscriptCompletion: true,
                  minEventSeq: finalEvt.seq,
                  ignoreFinalWithoutUserFacingMessage: true,
                  allowUserFacingDeltaCompletion: true,
                  onActivity: input.onActivity,
                }).catch(() => null)
              : null;
          const continuationEvents = this.consumeRunEvents(runId);
          openclawEvents = [...openclawEvents, ...continuationEvents];
          if (continuationEvt?.state === "transcript") {
            this.scheduleRunTraceCleanup(runId, "completed:empty_final_transcript_continuation");
            logger.info(
              {
                event: "artifact_delivery",
                stage: "transcript_reply_recovered_after_empty_final",
                taskId: input.taskId,
                openclawRunId: runId,
                sessionKey: input.sessionKey,
              },
              "Recovered final reply from session transcript after empty final event"
            );
            return await buildReplyRunResult({
              taskId: input.taskId,
              runId,
              sessionKey: input.sessionKey,
              deliverySystem,
              finalMessage: continuationEvt.message,
              transcriptFinalMessage: continuationEvt.message,
              openclawEvents,
              startedAtMs,
              devLogEnabled: this.devLogEnabled,
            });
          }
          if (continuationEvt?.state === "delta" || continuationEvt?.state === "final") {
            const continuationMessage =
              continuationEvt.message ?? readLatestUserFacingMessage(openclawEvents);
            if (continuationMessage !== undefined) {
              this.scheduleRunTraceCleanup(runId, `completed:empty_final_${continuationEvt.state}_continuation`);
              logger.info(
                {
                  event: "artifact_delivery",
                  stage: "reply_recovered_after_empty_final",
                  taskId: input.taskId,
                  openclawRunId: runId,
                  sessionKey: input.sessionKey,
                  continuationState: continuationEvt.state,
                },
                "Recovered final reply after empty final event"
              );
              return await buildReplyRunResult({
                taskId: input.taskId,
                runId,
                sessionKey: input.sessionKey,
                deliverySystem,
                finalMessage: continuationMessage,
                transcriptFinalMessage,
                openclawEvents,
                startedAtMs,
                devLogEnabled: this.devLogEnabled,
              });
            }
          }
          if (continuationEvt?.state === "aborted") {
            this.scheduleRunTraceCleanup(runId, "completed:empty_final_aborted_continuation");
            return {
              result: {
                outcome: "error",
                error: {
                  code: "ABORTED",
                  message: "Chat aborted after an empty final event",
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
          if (continuationEvt?.state === "error") {
            this.scheduleRunTraceCleanup(runId, "completed:empty_final_error_continuation");
            return {
              result: {
                outcome: "error",
                error: {
                  code: "GATEWAY_ERROR",
                  message: continuationEvt.errorMessage ?? "Chat error after an empty final event",
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
          this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
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
          const gatewayFinalMessage = finalEvt.message ?? readLatestUserFacingMessage(openclawEvents);
          let transcriptFinalMessage =
            finalAttemptMessage !== null
              ? await readLatestAssistantMessageFromSessionTranscript({
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage,
                  sessionState: transcriptSessionState,
                }).catch(() => undefined)
              : undefined;
          if (
            transcriptFinalMessage === undefined &&
            gatewayFinalMessage === undefined &&
            finalAttemptMessage !== null
          ) {
            transcriptFinalMessage = await waitForAssistantMessageFromSessionTranscript({
              sessionKey: input.sessionKey,
              requestMessage: finalAttemptMessage,
              timeoutMs: Math.min(1_000, Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))),
              sessionState: transcriptSessionState,
            }).catch(() => undefined);
          }
          const finalMessage = gatewayFinalMessage ?? transcriptFinalMessage;
          if (finalMessage !== undefined) {
            this.scheduleRunTraceCleanup(runId, "completed:aborted_user_facing_reply");
            logger.info(
              {
                event: "message_flow",
                direction: "openclaw_to_relay",
                stage: "response_recovered_after_abort",
                backendMessageId: input.taskId,
                relayMessageId: null,
                openclawRunId: runId,
              },
              "Recovered user-facing reply from aborted OpenClaw run"
            );
            return await buildReplyRunResult({
              taskId: input.taskId,
              runId,
              sessionKey: input.sessionKey,
              deliverySystem,
              finalMessage,
              transcriptFinalMessage,
              openclawEvents,
              startedAtMs,
              devLogEnabled: this.devLogEnabled,
            });
          }
          this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
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
          const transcriptFinalMessage =
            finalAttemptMessage !== null
              ? await waitForAssistantMessageFromSessionTranscript({
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage,
                  timeoutMs: Math.min(
                    OPENCLAW_DISCONNECT_TRANSCRIPT_RECOVERY_TIMEOUT_MS,
                    Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))
                  ),
                  sessionState: transcriptSessionState,
                })
              : undefined;
          if (transcriptFinalMessage !== undefined) {
            this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
            logger.info(
              {
                event: "artifact_delivery",
                stage: "transcript_reply_recovered_after_error",
                taskId: input.taskId,
                openclawRunId: runId,
                sessionKey: input.sessionKey,
                errorMessageLen: gatewayErrorMessage.length,
                errorMessagePreview: makeTextPreview(gatewayErrorMessage, 500),
              },
              "Recovered final reply from session transcript after a terminal error event"
            );
            return await buildReplyRunResult({
              taskId: input.taskId,
              runId,
              sessionKey: input.sessionKey,
              deliverySystem,
              finalMessage: transcriptFinalMessage,
              transcriptFinalMessage,
              openclawEvents,
              startedAtMs,
              devLogEnabled: this.devLogEnabled,
            });
          }
          const normalizedMessage = normalizeGatewayFailureMessage({
            message: gatewayErrorMessage,
            reason: classification.reason,
            attempts: attempt,
            transportRecoveryEnabled,
          });
          this.scheduleRunTraceCleanup(runId, `completed:${finalEvt.state}`);
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
        const openclawEvents = this.consumeRunEvents(runId);
        if (err instanceof GatewayRunDisconnectedError) {
          const disconnectMessage = err.message;
          logger.warn(
            {
              event: "message_flow",
              direction: "openclaw_to_relay",
              stage: "transport_disconnected",
              backendMessageId: input.taskId,
              relayMessageId: null,
              openclawRunId: runId,
              attempt,
              error: disconnectMessage,
            },
            "Gateway disconnected while waiting for a terminal chat event"
          );
          const transcriptFinalMessage =
            finalAttemptMessage !== null
              ? await waitForAssistantMessageFromSessionTranscript({
                  sessionKey: input.sessionKey,
                  requestMessage: finalAttemptMessage,
                  timeoutMs: Math.min(
                    OPENCLAW_ERROR_TRANSCRIPT_RECOVERY_TIMEOUT_MS,
                    Math.max(0, input.timeoutMs - (Date.now() - startedAtMs))
                  ),
                  sessionState: transcriptSessionState,
                })
              : undefined;
          if (transcriptFinalMessage !== undefined) {
            this.scheduleRunTraceCleanup(runId, "completed:transcript_recovered_after_disconnect");
            logger.info(
              {
                event: "message_flow",
                direction: "openclaw_to_relay",
                stage: "response_recovered_after_disconnect",
                backendMessageId: input.taskId,
                relayMessageId: null,
                openclawRunId: runId,
                disconnectMessage,
              },
              "Recovered final reply from session transcript after gateway disconnect"
            );
            return await buildReplyRunResult({
              taskId: input.taskId,
              runId,
              sessionKey: input.sessionKey,
              deliverySystem,
              finalMessage: transcriptFinalMessage,
              transcriptFinalMessage,
              openclawEvents,
              startedAtMs,
              devLogEnabled: this.devLogEnabled,
            });
          }
          const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
          const elapsedMs = Date.now() - startedAtMs;
          const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
          const retryable = attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
          if (!retryable) {
            this.scheduleRunTraceCleanup(runId, "wait_failed_disconnect");
            return {
              result: {
                outcome: "error",
                error: {
                  code: "GATEWAY_ERROR",
                  message: normalizeGatewayFailureMessage({
                    message: disconnectMessage,
                    reason: "transport_interruption",
                    attempts: attempt,
                    transportRecoveryEnabled,
                  }),
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
          transportRecoveryEnabled = true;
          await sleep(backoffMs);
          continue;
        }
        const timeoutMessage = err instanceof Error ? err.message : "Timed out waiting for final";
        const transcriptFinalMessage =
          finalAttemptMessage !== null
            ? await readLatestAssistantMessageFromSessionTranscript({
                sessionKey: input.sessionKey,
                requestMessage: finalAttemptMessage,
                sessionState: transcriptSessionState,
              }).catch(() => undefined)
            : undefined;
        if (transcriptFinalMessage !== undefined) {
          this.scheduleRunTraceCleanup(runId, "completed:transcript_recovered_after_timeout");
          logger.info(
            {
              event: "message_flow",
              direction: "openclaw_to_relay",
              stage: "response_recovered_after_timeout",
              backendMessageId: input.taskId,
              relayMessageId: null,
              openclawRunId: runId,
              timeoutMessage,
            },
            "Recovered final reply from session transcript after missing terminal event"
          );
          return await buildReplyRunResult({
            taskId: input.taskId,
            runId,
            sessionKey: input.sessionKey,
            deliverySystem,
            finalMessage: transcriptFinalMessage,
            transcriptFinalMessage,
            openclawEvents,
            startedAtMs,
            devLogEnabled: this.devLogEnabled,
          });
        }

        // Best-effort abort, then optionally retry (timeouts can be transient).
        try {
          if (this.devLogEnabled) {
            logger.warn(
              { taskId: input.taskId, runId, attempt, err: err instanceof Error ? err.message : String(err) },
              "Relay timed out waiting for chat final; aborting"
            );
          }
          await Promise.race([
            this.gateway.request("chat.abort", { sessionKey: input.sessionKey, runId }),
            sleep(250),
          ]);
        } catch {
          if (this.devLogEnabled) {
            logger.warn({ taskId: input.taskId, runId, attempt }, "Relay failed to abort chat after timeout");
          }
        }

        if (isSlashCommand) {
          logger.info(
            {
              event: "message_flow",
              direction: "openclaw_to_relay",
              stage: "slash_command_released_after_timeout",
              backendMessageId: input.taskId,
              relayMessageId: null,
              openclawRunId: runId,
              timeoutMessage,
            },
            "Slash-command did not emit a terminal event; releasing relay queue without a reply"
          );
          this.scheduleRunTraceCleanup(runId, "timeout_abort_slash_command");
          return {
            result: {
              outcome: "no_reply",
              noReply: {
                reason: "slash_command_timeout_without_terminal_event",
                runId,
                ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
              },
            },
            openclawMeta: { method: "chat.send", runId },
          };
        }
        const msg = timeoutMessage;
        const backoffMs = computeBackoffMs(this.retry.baseDelayMs, attempt - 1, this.retry.jitterMs);
        const elapsedMs = Date.now() - startedAtMs;
        const remainingMs = Math.max(0, input.timeoutMs - elapsedMs);
        const retryable = attempt < this.retry.attempts && remainingMs > backoffMs + 1000;
        if (!retryable) {
          const sawOnlyEmptyFinals =
            openclawEvents.some((event) => event.state === "final" && !extractTextFromMessage(event.message)) &&
            !readLatestUserFacingMessage(openclawEvents);
          this.scheduleRunTraceCleanup(
            runId,
            sawOnlyEmptyFinals ? "timeout_empty_final_no_message" : "wait_failed_timeout"
          );
          if (sawOnlyEmptyFinals) {
            return {
              result: {
                outcome: "error",
                error: {
                  code: "NO_MESSAGE",
                  message: "OpenClaw completed without a user-facing message before the relay task timeout",
                  runId,
                  ...(openclawEvents.length > 0 ? { openclawEvents } : {}),
                },
              },
              openclawMeta: { method: "chat.send", runId },
            };
          }
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
    } finally {
      this.activeRunByTaskId.delete(input.taskId);
    }
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
          this.registerRunTrace(runId, { sessionKey, backendMessageId: `session_new:${sessionKey}` });
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
            this.scheduleRunTraceCleanup(runId, "session_rotation_completed");
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

  private waitForFinal(
    runId: string,
    timeoutMs: number,
    opts?: {
      sessionKey?: string;
      requestMessage?: GatewayChatMessage;
      transcriptPollIntervalMs?: number;
      sessionState?: ResolvedSessionTranscriptState | null;
      allowTranscriptCompletion?: boolean;
      minEventSeq?: number;
      ignoreFinalWithoutUserFacingMessage?: boolean;
      allowUserFacingDeltaCompletion?: boolean;
      onActivity?: (activity: ChatRunActivity) => void;
    }
  ): Promise<ChatCompletionSignal> {
    return new Promise<ChatCompletionSignal>((resolve, reject) => {
      const pendingTerminalEvent = (this.runEventsByRunId.get(runId) ?? []).find(
        (event) => {
          if (opts?.minEventSeq !== undefined && event.seq <= opts.minEventSeq) {
            return false;
          }
          if (
            opts?.allowUserFacingDeltaCompletion &&
            event.state === "delta" &&
            extractTextFromMessage(event.message)
          ) {
            return true;
          }
          if (event.state !== "final" && event.state !== "error" && event.state !== "aborted") {
            return false;
          }
          return !(
            opts?.ignoreFinalWithoutUserFacingMessage &&
            event.state === "final" &&
            !extractTextFromMessage(event.message)
          );
        }
      );
      if (pendingTerminalEvent) {
        resolve(pendingTerminalEvent);
        return;
      }
      const finalize = (signal: ChatCompletionSignal): void => {
        const waiter = this.takeWaiter(runId);
        if (!waiter) return;
        resolve(signal);
      };
      const timeout = setTimeout(() => {
        const waiter = this.takeWaiter(runId);
        if (!waiter) return;
        reject(new Error("Timed out waiting for final"));
      }, timeoutMs);
      const waiter: Waiter = {
        resolve: finalize,
        reject,
        timeout,
        onActivity: opts?.onActivity,
        minEventSeq: opts?.minEventSeq,
        ignoreFinalWithoutUserFacingMessage: opts?.ignoreFinalWithoutUserFacingMessage,
        allowUserFacingDeltaCompletion: opts?.allowUserFacingDeltaCompletion,
      };
      this.waitersByRunId.set(runId, waiter);
      if (opts?.sessionKey && opts.requestMessage && opts.allowTranscriptCompletion !== false) {
        const pollTranscript = async (): Promise<void> => {
          const activeWaiter = this.waitersByRunId.get(runId);
          if (!activeWaiter || activeWaiter !== waiter || activeWaiter.transcriptPolling) {
            return;
          }
          activeWaiter.transcriptPolling = true;
          try {
            const transcriptMessage = await readLatestAssistantMessageFromSessionTranscript({
              sessionKey: opts.sessionKey!,
              requestMessage: opts.requestMessage!,
              sessionState: opts.sessionState,
            }).catch(() => undefined);
            if (transcriptMessage === undefined) {
              activeWaiter.transcriptCandidateKey = undefined;
              activeWaiter.transcriptCandidateFirstSeenAtMs = undefined;
              return;
            }
            if (this.waitersByRunId.get(runId) !== waiter) {
              return;
            }
            const candidateKey = buildTranscriptCandidateKey(transcriptMessage);
            const now = Date.now();
            if (activeWaiter.transcriptCandidateKey !== candidateKey) {
              activeWaiter.transcriptCandidateKey = candidateKey;
              activeWaiter.transcriptCandidateFirstSeenAtMs = now;
              activeWaiter.onActivity?.({
                runId,
                state: "transcript",
                observedAtMs: now,
              });
              return;
            }
            if (
              activeWaiter.transcriptCandidateFirstSeenAtMs === undefined ||
              now - activeWaiter.transcriptCandidateFirstSeenAtMs < OPENCLAW_TRANSCRIPT_FINAL_STABILITY_MS
            ) {
              return;
            }
            finalize({ state: "transcript", message: transcriptMessage });
          } finally {
            activeWaiter.transcriptPolling = false;
          }
        };
        const transcriptPollIntervalMs = Math.max(100, Math.trunc(opts.transcriptPollIntervalMs ?? 250));
        waiter.transcriptPoll = setInterval(() => {
          void pollTranscript();
        }, transcriptPollIntervalMs);
        waiter.transcriptPoll.unref?.();
        void pollTranscript();
      }
    });
  }

  private consumeRunEvents(runId: string): ChatEvent[] {
    const events = this.runEventsByRunId.get(runId) ?? [];
    this.runEventsByRunId.delete(runId);
    return events;
  }

  private rejectRunWaiter(runId: string, error: Error): void {
    const waiter = this.takeWaiter(runId);
    if (!waiter) return;
    waiter.reject(error);
  }

  private takeWaiter(runId: string): Waiter | null {
    const waiter = this.waitersByRunId.get(runId);
    if (!waiter) {
      return null;
    }
    if (waiter.transcriptPoll) {
      clearInterval(waiter.transcriptPoll);
    }
    clearTimeout(waiter.timeout);
    this.waitersByRunId.delete(runId);
    return waiter;
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

function isTransportBackedSession(sessionKey: string): boolean {
  return sessionKey.startsWith("tg:") || sessionKey.startsWith("whatsapp-personal:");
}

/**
 * Matches openclaw slash-commands such as `/new`, `/compact`, `/clear`
 * (optionally followed by whitespace-separated arguments). Such messages are
 * intercepted by openclaw's slash-command handler before reaching the model.
 */
const OPENCLAW_SLASH_COMMAND_PATTERN = /^\/[A-Za-z][\w-]*(?:\s[\s\S]*)?$/;

export function isOpenclawSlashCommand(messageText: string): boolean {
  return OPENCLAW_SLASH_COMMAND_PATTERN.test(messageText.trim());
}

export function applyTransportDeliveryInstructions(input: {
  sessionKey: string;
  messageText: string;
  deliverySystem: DeliverySystem;
}): string {
  void input.sessionKey;
  void input.deliverySystem;
  return isOpenclawSlashCommand(input.messageText) ? input.messageText.trim() : input.messageText;
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
