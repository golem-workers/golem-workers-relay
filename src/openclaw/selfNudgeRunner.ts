import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { classifySessionActivity } from "../conversation/activityIndex.js";

export const STATUS_NUDGE_MARKER = "[STATUS_NUDGE]";

const DEFAULT_NUDGE_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DISABLED_POLL_INTERVAL_MS = 30_000;
const MIN_BASE_TIMEOUT_MS = 1_000;
const MAX_MESSAGE_TEXT_LEN = 4_000;
const MAX_SELF_NUDGE_LATEST_USER_AGE_MS = 24 * 60 * 60 * 1000;
const RUNTIME_HISTORY_SCAN_LIMIT = 100;

export type RelaySelfNudgeSettings = {
  enabled: boolean;
  analyzedRecentMessageCount: number;
  baseTimeoutMs: number;
  model: string | null;
  debugMessagesEnabled: boolean;
  nudgeNoticeEnabled: boolean;
  finalNoticeEnabled: boolean;
  finalNoticeText: string;
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  lineIndex: number;
  timestampMs?: number;
  isLatestUserRequest?: boolean;
};

export type FreshestSessionTranscript = {
  sessionKey: string;
  sessionFile: string;
  mtimeMs: number;
  messages: TranscriptMessage[];
  latestUserMessage: TranscriptMessage | null;
};

export type SelfNudgeDecision = {
  shouldNudge: boolean;
  statusNudgeMessage: string | null;
  finalConfidence: number;
  reasonCode?: "final_answer" | "waiting_for_user" | "no_active_request" | "unknown";
  reason?: string;
};

type GatewayLike = {
  request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

export type SelfNudgeMessageSender = (input: {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  messageText: string;
  taskId: string;
  nowMs: number;
}) => Promise<void>;

export type SelfNudgeProcessedRecord = {
  sessionKey: string;
  userFingerprint: string;
  latestUserTimestampMs: number | null;
  latestUserLineIndex: number;
  decision: SelfNudgeDecision;
  analyzedAtMs: number;
  finalNoticeSentAtMs: number | null;
};

export type SelfNudgeProcessedStore = {
  get: (input: { sessionKey: string; userFingerprint: string }) => Promise<SelfNudgeProcessedRecord | null>;
  markAnalyzed: (
    input: Omit<SelfNudgeProcessedRecord, "finalNoticeSentAtMs"> & { finalNoticeSentAtMs?: number | null }
  ) => Promise<void>;
  markFinalNoticeSent: (input: {
    sessionKey: string;
    userFingerprint: string;
    sentAtMs: number;
  }) => Promise<void>;
};

export type SelfNudgeState = {
  sessionKey: string | null;
  latestUserFingerprint: string | null;
  consecutiveNudges: number;
  lastNudgeAtMs: number | null;
  lastFinalNoticeFingerprint?: string | null;
};

export type SelfNudgeRunner = {
  start: () => void;
  stop: () => void;
  tick: (nowMs?: number) => Promise<void>;
};

export function buildFinalDecisionNoticeText(input: {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  nowMs: number;
}): string {
  const finalMessage = findFinalAssistantMessage(input.transcript) ?? input.transcript.latestUserMessage;
  const preview = makeFinalNoticePreview(finalMessage?.text ?? "");
  const timeText = formatNoticeTime(finalMessage?.timestampMs ?? input.nowMs);
  return `FINAL(${input.decision.finalConfidence}%): message "${preview}" from ${timeText} is final`;
}

export function createSelfNudgeRunner(input: {
  settings: RelaySelfNudgeSettings;
  stateDir?: string;
  sendNudgeMessage: SelfNudgeMessageSender;
  openrouterProxyPort: number;
  openrouterProxyPathPrefix: string;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  gateway?: GatewayLike;
  processedStore?: SelfNudgeProcessedStore;
  notifyFinalDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    nowMs: number;
  }) => Promise<void>;
  notifyNudgeDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    messageText: string;
    nowMs: number;
  }) => Promise<void>;
}): SelfNudgeRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  const state: SelfNudgeState = {
    sessionKey: null,
    latestUserFingerprint: null,
    consecutiveNudges: 0,
    lastNudgeAtMs: null,
    lastFinalNoticeFingerprint: null,
  };
  const pollIntervalMs = Math.max(1_000, Math.trunc(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const processedStore =
    input.processedStore ??
    createFileSelfNudgeProcessedStore({
      stateDir: input.stateDir ?? resolveOpenclawStateDir(),
    });

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick().catch((error) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Relay self-nudge tick failed"
        );
      });
    }, Math.max(1_000, Math.trunc(delayMs)));
    timer.unref?.();
  };

  const tick = async (nowMs = Date.now()): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const settings = input.settings;
      if (!settings.enabled) {
        resetState(state);
        schedule(DISABLED_POLL_INTERVAL_MS);
        return;
      }
      const stateDir = input.stateDir ?? resolveOpenclawStateDir();
      const transcript =
        (input.gateway
          ? await readFreshestOpenclawRuntimeTranscript({
              gateway: input.gateway,
              analyzedRecentMessageCount: settings.analyzedRecentMessageCount,
            }).catch((error) => {
              logger.warn(
                { err: error instanceof Error ? error.message : String(error) },
                "Relay self-nudge runtime transcript read failed; falling back to local session files"
              );
              return null;
            })
          : null) ??
        (await readFreshestSessionTranscript({
          stateDir,
          analyzedRecentMessageCount: settings.analyzedRecentMessageCount,
        }));
      if (!transcript) {
        schedule(pollIntervalMs);
        return;
      }
      const outcome = await evaluateSelfNudgeTick({
        settings,
        transcript,
        state,
        nowMs,
        sendNudgeMessage: input.sendNudgeMessage,
        processedStore,
        notifyFinalDecision: input.notifyFinalDecision,
        notifyNudgeDecision: input.notifyNudgeDecision,
        decide: (decisionInput) =>
          decideSelfNudgeWithOpenRouter({
            ...decisionInput,
            fetchImpl: input.fetchImpl ?? fetch,
            openrouterProxyPort: input.openrouterProxyPort,
            openrouterProxyPathPrefix: input.openrouterProxyPathPrefix,
          }),
      });
      schedule(outcome.nextDelayMs ?? pollIntervalMs);
    } finally {
      ticking = false;
    }
  };

  return {
    start: () => {
      stopped = false;
      schedule(1_000);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    tick,
  };
}

export async function evaluateSelfNudgeTick(input: {
  settings: RelaySelfNudgeSettings;
  transcript: FreshestSessionTranscript;
  state: SelfNudgeState;
  nowMs: number;
  sendNudgeMessage: SelfNudgeMessageSender;
  processedStore?: SelfNudgeProcessedStore;
  notifyFinalDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    nowMs: number;
  }) => Promise<void>;
  notifyNudgeDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    messageText: string;
    nowMs: number;
  }) => Promise<void>;
  decide: (input: {
    settings: RelaySelfNudgeSettings;
    transcript: FreshestSessionTranscript;
  }) => Promise<SelfNudgeDecision>;
}): Promise<{ nudged: boolean; nextDelayMs: number }> {
  const latestUser = input.transcript.latestUserMessage;
  if (!latestUser) {
    resetState(input.state);
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }
  if (isStaleLatestUserMessage(latestUser, input.nowMs)) {
    resetState(input.state);
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  const userFingerprint = fingerprintMessage(latestUser);
  if (
    input.state.sessionKey !== input.transcript.sessionKey ||
    input.state.latestUserFingerprint !== userFingerprint
  ) {
    input.state.sessionKey = input.transcript.sessionKey;
    input.state.latestUserFingerprint = userFingerprint;
    input.state.consecutiveNudges = 0;
    input.state.lastNudgeAtMs = null;
    input.state.lastFinalNoticeFingerprint = null;
  }

  const waitMs = computeSelfNudgeWaitMs(input.settings.baseTimeoutMs, input.state.consecutiveNudges);
  const anchorMs = input.state.lastNudgeAtMs ?? input.transcript.mtimeMs;
  const elapsedMs = input.nowMs - anchorMs;
  if (elapsedMs < waitMs) {
    return { nudged: false, nextDelayMs: waitMs - elapsedMs };
  }

  const existingRecord = await input.processedStore?.get({
    sessionKey: input.transcript.sessionKey,
    userFingerprint,
  });
  if (existingRecord && isClosedDecision(existingRecord.decision)) {
    input.state.lastFinalNoticeFingerprint = existingRecord.finalNoticeSentAtMs ? userFingerprint : null;
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  const decision = await input.decide({
    settings: input.settings,
    transcript: input.transcript,
  });
  await input.processedStore?.markAnalyzed({
    sessionKey: input.transcript.sessionKey,
    userFingerprint,
    latestUserTimestampMs: latestUser.timestampMs ?? null,
    latestUserLineIndex: latestUser.lineIndex,
    decision,
    analyzedAtMs: input.nowMs,
  });
  if (!decision.shouldNudge) {
    if (
      input.settings.finalNoticeEnabled &&
      input.notifyFinalDecision &&
      isFinalAnswerDecision(decision) &&
      input.state.lastFinalNoticeFingerprint !== userFingerprint
    ) {
      await input.notifyFinalDecision({
        transcript: input.transcript,
        decision,
        nowMs: input.nowMs,
      });
      input.state.lastFinalNoticeFingerprint = userFingerprint;
      await input.processedStore?.markFinalNoticeSent({
        sessionKey: input.transcript.sessionKey,
        userFingerprint,
        sentAtMs: input.nowMs,
      });
    }
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  const body = normalizeNudgeBody(decision.statusNudgeMessage);
  const messageText = formatStatusNudgeMessage(body);
  if (input.settings.nudgeNoticeEnabled && input.notifyNudgeDecision) {
    await input.notifyNudgeDecision({
      transcript: input.transcript,
      decision,
      messageText,
      nowMs: input.nowMs,
    });
  }
  const taskId = `self_nudge_${randomUUID()}`;
  await input.sendNudgeMessage({
    transcript: input.transcript,
    decision,
    messageText,
    taskId,
    nowMs: input.nowMs,
  });
  input.state.consecutiveNudges += 1;
  input.state.lastNudgeAtMs = input.nowMs;
  return {
    nudged: true,
    nextDelayMs: computeSelfNudgeWaitMs(input.settings.baseTimeoutMs, input.state.consecutiveNudges),
  };
}

export async function readFreshestSessionTranscript(input: {
  stateDir: string;
  analyzedRecentMessageCount: number;
}): Promise<FreshestSessionTranscript | null> {
  const sessionsDir = path.join(input.stateDir, "agents", "main", "sessions");
  const sessionsMapFile = path.join(sessionsDir, "sessions.json");
  const raw = await fs.readFile(sessionsMapFile, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const candidates: Array<{ sessionKey: string; sessionFile: string; mtimeMs: number }> = [];
  for (const [mapKey, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) continue;
    const rawSessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
    if (!rawSessionFile) continue;
    const sessionFile = path.isAbsolute(rawSessionFile)
      ? rawSessionFile
      : path.join(sessionsDir, rawSessionFile);
    const stat = await fs.stat(sessionFile).catch(() => null);
    if (!stat?.isFile()) continue;
    candidates.push({
      sessionKey: normalizeSessionKey(mapKey),
      sessionFile,
      mtimeMs: stat.mtimeMs,
    });
  }
  const transcripts: FreshestSessionTranscript[] = [];
  for (const candidate of candidates) {
    const transcriptMessages = await readTranscriptMessages(candidate.sessionFile);
    const latestRawUserMessage = findLatestUserMessage(transcriptMessages);
    if (!latestRawUserMessage) continue;
    if (!canUseTranscriptForSelfNudge(candidate.sessionKey, latestRawUserMessage.text)) {
      continue;
    }
    const analysis = buildSelfNudgeAnalysisTranscript({
      messages: transcriptMessages,
      analyzedRecentMessageCount: input.analyzedRecentMessageCount,
    });
    if (!analysis) {
      continue;
    }
    transcripts.push({
      ...candidate,
      messages: analysis.messages,
      latestUserMessage: analysis.latestUserMessage,
    });
  }
  transcripts.sort(compareSessionTranscriptsForNudge);
  return transcripts[0] ?? null;
}

export async function readFreshestOpenclawRuntimeTranscript(input: {
  gateway: GatewayLike;
  analyzedRecentMessageCount: number;
}): Promise<FreshestSessionTranscript | null> {
  const sessionsPayload = await input.gateway.request(
    "sessions.list",
    {
      agentId: "main",
      limit: 50,
    },
    { timeoutMs: 5_000 }
  );
  const candidates = readRuntimeSessionCandidates(sessionsPayload);
  const transcripts: FreshestSessionTranscript[] = [];
  for (const candidate of candidates) {
    const historyPayload = await readRuntimeChatHistory(input.gateway, candidate.gatewaySessionKey, {
      limit: computeRuntimeHistoryScanLimit(input.analyzedRecentMessageCount),
    });
    const messages = readRuntimeHistoryMessages(historyPayload);
    const latestRawUserMessage = findLatestUserMessage(messages);
    if (!latestRawUserMessage) continue;
    if (!canUseTranscriptForSelfNudge(candidate.sessionKey, latestRawUserMessage.text)) {
      continue;
    }
    const analysis = buildSelfNudgeAnalysisTranscript({
      messages,
      analyzedRecentMessageCount: input.analyzedRecentMessageCount,
    });
    if (!analysis) continue;
    transcripts.push({
      sessionKey: candidate.sessionKey,
      sessionFile: `gateway://chat.history/${candidate.gatewaySessionKey}`,
      mtimeMs: candidate.updatedAtMs,
      messages: analysis.messages,
      latestUserMessage: analysis.latestUserMessage,
    });
  }
  transcripts.sort(compareSessionTranscriptsForNudge);
  return transcripts[0] ?? null;
}

export function buildSelfNudgeAnalysisTranscript(input: {
  messages: TranscriptMessage[];
  analyzedRecentMessageCount: number;
}): Pick<FreshestSessionTranscript, "messages" | "latestUserMessage"> | null {
  const latestUserMessage = findLatestUserRequestMessage(input.messages);
  if (!latestUserMessage) return null;
  const assistantMessagesAfterLatestUser = input.messages.filter(
    (message) => message.role === "assistant" && message.lineIndex > latestUserMessage.lineIndex
  );
  const maxAssistantMessages = Math.max(0, Math.trunc(input.analyzedRecentMessageCount));
  const selectedAssistantMessages =
    maxAssistantMessages > 0 ? assistantMessagesAfterLatestUser.slice(-maxAssistantMessages) : [];
  const latestUserRequest = { ...latestUserMessage, isLatestUserRequest: true as const };
  return {
    latestUserMessage: latestUserRequest,
    messages: [latestUserRequest, ...selectedAssistantMessages],
  };
}

function computeRuntimeHistoryScanLimit(analyzedRecentMessageCount: number): number {
  const requested = Math.max(0, Math.trunc(analyzedRecentMessageCount));
  return Math.max(RUNTIME_HISTORY_SCAN_LIMIT, requested + 1);
}

function canUseTranscriptForSelfNudge(sessionKey: string, latestUserText: string): boolean {
  const classification = classifySessionActivity({
    sessionKey,
    latestUserText,
  });
  if (classification === "external_user_chat") return true;
  return classification === "status_nudge" && isUserFacingRuntimeSessionKey(sessionKey);
}

function compareSessionTranscriptsForNudge(
  a: FreshestSessionTranscript,
  b: FreshestSessionTranscript
): number {
  const aLatestUserMs = a.latestUserMessage?.timestampMs ?? a.mtimeMs;
  const bLatestUserMs = b.latestUserMessage?.timestampMs ?? b.mtimeMs;
  return bLatestUserMs - aLatestUserMs || b.mtimeMs - a.mtimeMs;
}

type RuntimeSessionCandidate = {
  gatewaySessionKey: string;
  sessionKey: string;
  updatedAtMs: number;
};

function readRuntimeSessionCandidates(payload: unknown): RuntimeSessionCandidate[] {
  const sessions = isPlainObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
  return sessions
    .flatMap((session): RuntimeSessionCandidate[] => {
      if (!isPlainObject(session)) return [];
      const gatewaySessionKey = readString(session.key);
      if (!gatewaySessionKey) return [];
      const sessionKey = normalizeSessionKey(gatewaySessionKey);
      if (!isUserFacingRuntimeSessionKey(sessionKey)) return [];
      const updatedAtMs = readTimestampMs(session.updatedAt) ?? readTimestampMs(session.lastUserMessageAt);
      if (updatedAtMs == null) return [];
      return [{ gatewaySessionKey, sessionKey, updatedAtMs }];
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

async function readRuntimeChatHistory(
  gateway: GatewayLike,
  gatewaySessionKey: string,
  input: { limit: number }
): Promise<unknown> {
  try {
    return await gateway.request(
      "chat.history",
      {
        sessionKey: gatewaySessionKey,
        limit: input.limit,
        maxChars: MAX_MESSAGE_TEXT_LEN,
      },
      { timeoutMs: 5_000 }
    );
  } catch (error) {
    const normalizedSessionKey = normalizeSessionKey(gatewaySessionKey);
    if (normalizedSessionKey === gatewaySessionKey) throw error;
    return gateway.request(
      "chat.history",
      {
        sessionKey: normalizedSessionKey,
        limit: input.limit,
        maxChars: MAX_MESSAGE_TEXT_LEN,
      },
      { timeoutMs: 5_000 }
    );
  }
}

function readRuntimeHistoryMessages(payload: unknown): TranscriptMessage[] {
  const messages = isPlainObject(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  return messages.flatMap((message, index): TranscriptMessage[] => {
    if (!isPlainObject(message)) return [];
    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    if (!role) return [];
    const text = extractTextFromMessage(message).trim();
    if (!text) return [];
    const timestampMs = readTimestampMs(message.createdAt) ?? readTimestampMs(message.timestamp);
    return [
      typeof timestampMs === "number"
        ? { role, text, lineIndex: index, timestampMs }
        : { role, text, lineIndex: index },
    ];
  });
}

function isUserFacingRuntimeSessionKey(sessionKey: string): boolean {
  if (!sessionKey || sessionKey === "main" || sessionKey === "global" || sessionKey === "unknown") return false;
  if (sessionKey.startsWith("agent:")) return false;
  if (!sessionKey.includes(":")) return false;
  return true;
}

function isStaleLatestUserMessage(message: TranscriptMessage, nowMs: number): boolean {
  if (typeof message.timestampMs !== "number") return false;
  return nowMs - message.timestampMs > MAX_SELF_NUDGE_LATEST_USER_AGE_MS;
}

export function computeSelfNudgeWaitMs(baseTimeoutMs: number, consecutiveNudges: number): number {
  return Math.max(MIN_BASE_TIMEOUT_MS, Math.trunc(baseTimeoutMs)) * (Math.max(0, Math.trunc(consecutiveNudges)) + 1);
}

export function formatStatusNudgeMessage(body: string): string {
  const trimmed = body.trim();
  return trimmed.startsWith(STATUS_NUDGE_MARKER)
    ? trimmed
    : `${STATUS_NUDGE_MARKER}\n${trimmed}`;
}

async function decideSelfNudgeWithOpenRouter(input: {
  settings: RelaySelfNudgeSettings;
  transcript: FreshestSessionTranscript;
  openrouterProxyPort: number;
  openrouterProxyPathPrefix: string;
  fetchImpl: typeof fetch;
}): Promise<SelfNudgeDecision> {
  const model = normalizeOpenRouterModel(input.settings.model);
  const response = await input.fetchImpl(
    buildOpenRouterProxyChatCompletionsUrl({
      port: input.openrouterProxyPort,
      pathPrefix: input.openrouterProxyPathPrefix,
    }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSelfNudgeSystemPrompt(),
          },
          {
            role: "user",
            content: JSON.stringify({
              sessionKey: input.transcript.sessionKey,
              latestMessages: input.transcript.messages.map((message) => ({
                role: message.role,
                text: truncateText(message.text, MAX_MESSAGE_TEXT_LEN),
                ...(message.isLatestUserRequest ? { isLatestUserRequest: true } : {}),
              })),
            }),
          },
        ],
      }),
    }
  );
  if (!response.ok) {
    throw new Error(`OpenRouter nudge analysis failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  const content = extractChatCompletionContent(payload);
  if (!content) {
    throw new Error("OpenRouter nudge analysis returned empty content");
  }
  return parseSelfNudgeDecision(content);
}

export function buildOpenRouterProxyChatCompletionsUrl(input: {
  port: number;
  pathPrefix: string;
}): string {
  const normalizedPrefix = `/${input.pathPrefix.trim().replace(/^\/+|\/+$/g, "")}`;
  return `http://127.0.0.1:${input.port}${normalizedPrefix}/api/v1/chat/completions`;
}

async function readTranscriptMessages(sessionFile: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const messages: TranscriptMessage[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || parsed.type !== "message") return;
    const message = parsed.message;
    if (!isPlainObject(message)) return;
    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    if (!role) return;
    const text = extractTextFromMessage(message).trim();
    if (!text) return;
    const timestampMs = extractMessageTimestampMs(parsed, message);
    messages.push(
      typeof timestampMs === "number"
        ? { role, text, lineIndex: index, timestampMs }
        : { role, text, lineIndex: index }
    );
  });
  return messages;
}

function extractMessageTimestampMs(
  record: Record<string, unknown>,
  message: Record<string, unknown>
): number | undefined {
  return parseTimestampMs(message.timestamp) ?? parseTimestampMs(record.timestamp);
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return parseTimestampMs(value);
}

function buildSelfNudgeSystemPrompt(): string {
  return [
    "You decide whether an OpenClaw agent should receive a self-nudge to continue active work.",
    "Inspect only the provided OpenClaw session transcript messages.",
    "The message with isLatestUserRequest=true is the latest real user request and is always the task to judge.",
    "Assistant messages are limited to the configured recent agent messages after that user request; ignore older work not shown.",
    "Return strict JSON with keys: shouldNudge, statusNudgeMessage, finalConfidence, reasonCode, reason.",
    "Set finalConfidence to an integer from 0 to 100: your confidence that the latest user request has a final assistant answer.",
    "Use finalConfidence=100 only when you are completely certain the assistant finished the latest request.",
    "Set reasonCode to one of: final_answer, waiting_for_user, no_active_request, unknown.",
    "Set reasonCode=final_answer only when finalConfidence is greater than 90.",
    "Set shouldNudge=false with reasonCode=final_answer when finalConfidence is greater than 90.",
    "Set shouldNudge=true only when finalConfidence is 90 or lower and the latest user request appears unfinished, blocked by no external user input, or the assistant was still actively working.",
    "A partial progress update is not final when the user asked for all tasks or a complete outcome and the assistant says some work remains.",
    "Set shouldNudge=false with reasonCode=waiting_for_user when the assistant asked the user a necessary question.",
    "Set shouldNudge=false with reasonCode=no_active_request when there is no user request to continue.",
    "When shouldNudge=true, statusNudgeMessage must clearly name the unfinished part relative to the latest user request, then ask the agent to continue and report new evidence.",
    "Do not include the [STATUS_NUDGE] marker; the relay adds it.",
  ].join("\n");
}

function parseSelfNudgeDecision(raw: string): SelfNudgeDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return {
      shouldNudge: true,
      statusNudgeMessage: normalizeNudgeBody(raw),
      finalConfidence: 0,
      reason: "model_returned_non_json",
    };
  }
  if (!isPlainObject(parsed)) {
    return { shouldNudge: false, statusNudgeMessage: null, finalConfidence: 0, reason: "model_returned_non_object" };
  }
  const finalConfidence = parseFinalConfidence(parsed.finalConfidence);
  const shouldNudge = parsed.shouldNudge === true && finalConfidence <= 90;
  const statusNudgeMessage =
    typeof parsed.statusNudgeMessage === "string" && parsed.statusNudgeMessage.trim().length > 0
      ? parsed.statusNudgeMessage.trim()
      : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  const reasonCode = parseSelfNudgeReasonCode(parsed.reasonCode);
  return {
    shouldNudge,
    statusNudgeMessage: shouldNudge ? normalizeNudgeBody(statusNudgeMessage) : null,
    finalConfidence,
    ...(reasonCode ? { reasonCode } : {}),
    reason,
  };
}

function parseFinalConfidence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampFinalConfidence(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return clampFinalConfidence(parsed);
    }
  }
  return 0;
}

function clampFinalConfidence(value: number): number {
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function parseSelfNudgeReasonCode(value: unknown): SelfNudgeDecision["reasonCode"] | undefined {
  return value === "final_answer" ||
    value === "waiting_for_user" ||
    value === "no_active_request" ||
    value === "unknown"
    ? value
    : undefined;
}

function isFinalAnswerDecision(decision: SelfNudgeDecision): boolean {
  return decision.finalConfidence > 90;
}

function isClosedDecision(decision: SelfNudgeDecision): boolean {
  return !decision.shouldNudge;
}

export function createFileSelfNudgeProcessedStore(input: {
  stateDir: string;
  filePath?: string;
  maxRecords?: number;
}): SelfNudgeProcessedStore {
  const filePath =
    input.filePath ?? path.join(input.stateDir, "agents", "main", "golem-workers", "relay-self-nudge-index.json");
  const maxRecords = Math.max(100, Math.trunc(input.maxRecords ?? 5_000));
  let cache: { records: Record<string, SelfNudgeProcessedRecord> } | null = null;

  const load = async (): Promise<{ records: Record<string, SelfNudgeProcessedRecord> }> => {
    if (cache) return cache;
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) {
      cache = { records: {} };
      return cache;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      cache = { records: parseProcessedRecords(parsed) };
    } catch {
      cache = { records: {} };
    }
    return cache;
  };

  const save = async (store: { records: Record<string, SelfNudgeProcessedRecord> }): Promise<void> => {
    const entries = Object.entries(store.records).sort(([, a], [, b]) => b.analyzedAtMs - a.analyzedAtMs);
    store.records = Object.fromEntries(entries.slice(0, maxRecords));
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, records: store.records }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  };

  return {
    get: async ({ sessionKey, userFingerprint }) => {
      const store = await load();
      return store.records[processedRecordKey(sessionKey, userFingerprint)] ?? null;
    },
    markAnalyzed: async (record) => {
      const store = await load();
      const key = processedRecordKey(record.sessionKey, record.userFingerprint);
      store.records[key] = {
        ...record,
        finalNoticeSentAtMs: record.finalNoticeSentAtMs ?? store.records[key]?.finalNoticeSentAtMs ?? null,
      };
      await save(store);
    },
    markFinalNoticeSent: async ({ sessionKey, userFingerprint, sentAtMs }) => {
      const store = await load();
      const key = processedRecordKey(sessionKey, userFingerprint);
      const existing = store.records[key];
      if (!existing) return;
      store.records[key] = { ...existing, finalNoticeSentAtMs: sentAtMs };
      await save(store);
    },
  };
}

function processedRecordKey(sessionKey: string, userFingerprint: string): string {
  return createHash("sha256").update(`${sessionKey}\n${userFingerprint}`).digest("hex");
}

function parseProcessedRecords(value: unknown): Record<string, SelfNudgeProcessedRecord> {
  const rawRecords = isPlainObject(value) && isPlainObject(value.records) ? value.records : {};
  const records: Record<string, SelfNudgeProcessedRecord> = {};
  for (const [key, rawRecord] of Object.entries(rawRecords)) {
    if (!isPlainObject(rawRecord)) continue;
    const sessionKey = typeof rawRecord.sessionKey === "string" ? rawRecord.sessionKey : "";
    const userFingerprint = typeof rawRecord.userFingerprint === "string" ? rawRecord.userFingerprint : "";
    const decision = parseStoredDecision(rawRecord.decision);
    const analyzedAtMs = typeof rawRecord.analyzedAtMs === "number" ? rawRecord.analyzedAtMs : null;
    const latestUserLineIndex =
      typeof rawRecord.latestUserLineIndex === "number" ? rawRecord.latestUserLineIndex : null;
    if (!sessionKey || !userFingerprint || !decision || analyzedAtMs == null || latestUserLineIndex == null) {
      continue;
    }
    records[key] = {
      sessionKey,
      userFingerprint,
      latestUserTimestampMs:
        typeof rawRecord.latestUserTimestampMs === "number" ? rawRecord.latestUserTimestampMs : null,
      latestUserLineIndex,
      decision,
      analyzedAtMs,
      finalNoticeSentAtMs:
        typeof rawRecord.finalNoticeSentAtMs === "number" ? rawRecord.finalNoticeSentAtMs : null,
    };
  }
  return records;
}

function parseStoredDecision(value: unknown): SelfNudgeDecision | null {
  if (!isPlainObject(value)) return null;
  const shouldNudge = value.shouldNudge === true;
  const statusNudgeMessage =
    typeof value.statusNudgeMessage === "string" && value.statusNudgeMessage.trim()
      ? value.statusNudgeMessage.trim()
      : null;
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  const reasonCode = parseSelfNudgeReasonCode(value.reasonCode);
  return {
    shouldNudge,
    statusNudgeMessage,
    finalConfidence: parseStoredFinalConfidence(value),
    ...(reasonCode ? { reasonCode } : {}),
    reason,
  };
}

function parseStoredFinalConfidence(value: Record<string, unknown>): number {
  const parsed = parseFinalConfidence(value.finalConfidence);
  if (parsed > 0 || "finalConfidence" in value) return parsed;
  const reasonCode = parseSelfNudgeReasonCode(value.reasonCode);
  return reasonCode === "final_answer" ? 100 : 0;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function extractChatCompletionContent(payload: unknown): string | null {
  const choices: unknown[] = isPlainObject(payload) && Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0] ?? null;
  if (!isPlainObject(choice)) return null;
  const message = choice.message;
  if (!isPlainObject(message)) return null;
  return typeof message.content === "string" && message.content.trim().length > 0
    ? message.content.trim()
    : null;
}

function extractTextFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isPlainObject(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "text" && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

function findLatestUserMessage(messages: TranscriptMessage[]): TranscriptMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return messages[i];
  }
  return null;
}

function findLatestUserRequestMessage(messages: TranscriptMessage[]): TranscriptMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user" && !isStatusNudgeMessage(message.text)) return message;
  }
  return null;
}

function isStatusNudgeMessage(text: string): boolean {
  return text.trimStart().startsWith(STATUS_NUDGE_MARKER);
}

function findFinalAssistantMessage(transcript: FreshestSessionTranscript): TranscriptMessage | null {
  const latestUserLineIndex = transcript.latestUserMessage?.lineIndex ?? -1;
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (message?.role === "assistant" && message.lineIndex > latestUserLineIndex) {
      return message;
    }
  }
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return null;
}

function makeFinalNoticePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const preview = normalized.slice(0, 10);
  return normalized.length > preview.length ? `${preview}...` : preview;
}

function formatNoticeTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return "unknown";
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function fingerprintMessage(message: TranscriptMessage): string {
  return createHash("sha256")
    .update(`${message.lineIndex}\n${message.role}\n${message.text}`)
    .digest("hex");
}

function normalizeNudgeBody(raw: string | null | undefined): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return (
    text ||
    "Continue the in-flight work on the user's latest request. Report new evidence and the next action you are taking now. If you are genuinely blocked and cannot proceed without external input, say so clearly and use Status: 100% complete."
  );
}

function normalizeOpenRouterModel(model: string | null): string {
  const raw = model?.trim() || DEFAULT_NUDGE_MODEL;
  return raw.toLowerCase().startsWith("openrouter/") ? raw.slice("openrouter/".length) : raw;
}

function normalizeSessionKey(mapKey: string): string {
  return mapKey.startsWith("agent:main:") ? mapKey.slice("agent:main:".length) : mapKey;
}

function resetState(state: SelfNudgeState): void {
  state.sessionKey = null;
  state.latestUserFingerprint = null;
  state.consecutiveNudges = 0;
  state.lastNudgeAtMs = null;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
