import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { classifySessionActivity } from "../conversation/activityIndex.js";

export const STATUS_NUDGE_MARKER = "[STATUS_NUDGE]";
export const STATUS_NUDGE_BODY =
  "Continue from where you left off, or if you have finished, report the result.";
export const STATUS_NUDGE_MESSAGE = `${STATUS_NUDGE_MARKER}\n${STATUS_NUDGE_BODY}`;

const DEFAULT_NUDGE_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DISABLED_POLL_INTERVAL_MS = 30_000;
const MIN_BASE_TIMEOUT_MS = 1_000;
const MAX_MESSAGE_TEXT_LEN = 4_000;
const MAX_SELF_NUDGE_LATEST_USER_AGE_MS = 24 * 60 * 60 * 1000;
const RUNTIME_HISTORY_SCAN_LIMIT = 100;
const FINAL_ANSWER_CONFIDENCE_THRESHOLD = 90;

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
  reasonCode?:
    | "final_answer"
    | "waiting_for_user"
    | "no_active_request"
    | "unknown";
  reason?: string;
};

export type SelfNudgeVisibleFinalityEvidence = {
  visibleText?: string;
  deliveredAtMs?: number;
  deliveryKind?: "final" | "terminal_error" | "terminal_no_reply";
};

type GatewayLike = {
  request: (
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>;
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
  analysisFingerprint?: string | null;
  latestUserTimestampMs: number | null;
  latestUserLineIndex: number;
  decision: SelfNudgeDecision;
  analyzedAtMs: number;
  finalNoticeSentAtMs: number | null;
};

export type SelfNudgeProcessedStore = {
  get: (input: {
    sessionKey: string;
    userFingerprint: string;
  }) => Promise<SelfNudgeProcessedRecord | null>;
  markAnalyzed: (
    input: Omit<SelfNudgeProcessedRecord, "finalNoticeSentAtMs"> & {
      finalNoticeSentAtMs?: number | null;
    },
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
  visibleFinality?: SelfNudgeVisibleFinalityEvidence | null;
}): string {
  const finalMessage =
    findFinalAssistantMessage(input.transcript) ??
    input.transcript.latestUserMessage;
  const preview = makeFinalNoticePreview(
    input.visibleFinality?.visibleText ?? finalMessage?.text ?? "",
  );
  const timeText = formatNoticeTime(
    input.visibleFinality?.deliveredAtMs ??
      finalMessage?.timestampMs ??
      input.nowMs,
  );
  return `TURN_FINAL: message "${preview}" from ${timeText} is final`;
}

export function buildNudgeDecisionNoticeText(input: {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  messageText: string;
  nowMs: number;
}): string {
  const userPreview = makeNoticePreview(
    input.transcript.latestUserMessage?.text ?? "",
  );
  const assistantPreview = makeNoticePreview(
    findFinalAssistantMessage(input.transcript)?.text ?? "",
  );
  const assistantText = assistantPreview
    ? ` assistant "${assistantPreview}"`
    : "";
  return `NUDGE(${input.decision.finalConfidence}% final): latest user "${userPreview}"${assistantText}\n${input.messageText}`;
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
  isLocallyIdle?: () => boolean;
  confirmIdle?: () => boolean | Promise<boolean>;
  processedStore?: SelfNudgeProcessedStore;
  notifyFinalDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    nowMs: number;
    visibleFinality?: SelfNudgeVisibleFinalityEvidence | null;
  }) => Promise<void>;
  notifyNudgeDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
    messageText: string;
    nowMs: number;
  }) => Promise<void>;
  findVisibleFinality?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
  }) =>
    | Promise<SelfNudgeVisibleFinalityEvidence | null>
    | SelfNudgeVisibleFinalityEvidence
    | null;
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
  const pollIntervalMs = Math.max(
    1_000,
    Math.trunc(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
  );
  const processedStore =
    input.processedStore ??
    createFileSelfNudgeProcessedStore({
      stateDir: input.stateDir ?? resolveOpenclawStateDir(),
    });

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        void tick().catch((error) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Relay self-nudge tick failed",
          );
        });
      },
      Math.max(1_000, Math.trunc(delayMs)),
    );
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
      if (!input.gateway) {
        logger.warn(
          "Relay self-nudge skipped because OpenClaw gateway is unavailable",
        );
        schedule(pollIntervalMs);
        return;
      }
      if (input.isLocallyIdle && !input.isLocallyIdle()) {
        schedule(pollIntervalMs);
        return;
      }
      const transcript = await readFreshestOpenclawRuntimeTranscript({
        gateway: input.gateway,
        analyzedRecentMessageCount: settings.analyzedRecentMessageCount,
      }).catch((error) => {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Relay self-nudge runtime transcript read failed",
        );
        return null;
      });
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
        findVisibleFinality: input.findVisibleFinality,
        confirmIdle: input.confirmIdle,
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
    visibleFinality?: SelfNudgeVisibleFinalityEvidence | null;
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
  confirmIdle?: () => boolean | Promise<boolean>;
  findVisibleFinality?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
  }) =>
    | Promise<SelfNudgeVisibleFinalityEvidence | null>
    | SelfNudgeVisibleFinalityEvidence
    | null;
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

  const waitMs = computeSelfNudgeWaitMs(
    input.settings.baseTimeoutMs,
    input.state.consecutiveNudges,
  );
  const latestAssistantActivityMs = findLatestAssistantActivityAfterLatestUser(
    input.transcript,
  );
  const transcriptActivityMs =
    latestAssistantActivityMs == null
      ? input.transcript.mtimeMs
      : Math.max(input.transcript.mtimeMs, latestAssistantActivityMs);
  const anchorMs = input.state.lastNudgeAtMs ?? transcriptActivityMs;
  const elapsedMs = input.nowMs - anchorMs;
  if (elapsedMs < waitMs) {
    return { nudged: false, nextDelayMs: waitMs - elapsedMs };
  }

  const existingRecord = await input.processedStore?.get({
    sessionKey: input.transcript.sessionKey,
    userFingerprint,
  });
  if (existingRecord && isClosedDecision(existingRecord.decision)) {
    input.state.lastFinalNoticeFingerprint = existingRecord.finalNoticeSentAtMs
      ? userFingerprint
      : null;
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  const analysisFingerprint = fingerprintAnalysisMessages(
    input.transcript.messages,
  );
  if (
    existingRecord &&
    existingRecord.decision.shouldNudge &&
    existingRecord.analysisFingerprint === analysisFingerprint
  ) {
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  if (!(await confirmSelfNudgeIdle(input.confirmIdle))) {
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  let decision = await input.decide({
    settings: input.settings,
    transcript: input.transcript,
  });
  let visibleFinality: SelfNudgeVisibleFinalityEvidence | null = null;
  if (isFinalAnswerDecision(decision) && input.findVisibleFinality) {
    visibleFinality = await input.findVisibleFinality({
      transcript: input.transcript,
      decision,
    });
    if (!visibleFinality) {
      decision = {
        shouldNudge: true,
        statusNudgeMessage: null,
        finalConfidence: 0,
        reasonCode: "unknown",
        reason: "private_final_without_visible_delivery",
      };
    }
  }
  if (!(await confirmSelfNudgeIdle(input.confirmIdle))) {
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }
  if (!decision.shouldNudge) {
    await input.processedStore?.markAnalyzed({
      sessionKey: input.transcript.sessionKey,
      userFingerprint,
      analysisFingerprint,
      latestUserTimestampMs: latestUser.timestampMs ?? null,
      latestUserLineIndex: latestUser.lineIndex,
      decision,
      analyzedAtMs: input.nowMs,
    });
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
        visibleFinality,
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

  const messageText = STATUS_NUDGE_MESSAGE;
  const taskId = `self_nudge_${randomUUID()}`;
  await input.sendNudgeMessage({
    transcript: input.transcript,
    decision,
    messageText,
    taskId,
    nowMs: input.nowMs,
  });
  await input.processedStore?.markAnalyzed({
    sessionKey: input.transcript.sessionKey,
    userFingerprint,
    analysisFingerprint,
    latestUserTimestampMs: latestUser.timestampMs ?? null,
    latestUserLineIndex: latestUser.lineIndex,
    decision,
    analyzedAtMs: input.nowMs,
  });
  input.state.consecutiveNudges += 1;
  input.state.lastNudgeAtMs = input.nowMs;
  if (input.settings.nudgeNoticeEnabled && input.notifyNudgeDecision) {
    await input.notifyNudgeDecision({
      transcript: input.transcript,
      decision,
      messageText,
      nowMs: input.nowMs,
    });
  }
  return {
    nudged: true,
    nextDelayMs: computeSelfNudgeWaitMs(
      input.settings.baseTimeoutMs,
      input.state.consecutiveNudges,
    ),
  };
}

async function confirmSelfNudgeIdle(
  confirmIdle: (() => boolean | Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!confirmIdle) return true;
  try {
    return (await confirmIdle()) === true;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Relay self-nudge idle confirmation failed closed",
    );
    return false;
  }
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

  const candidates: Array<{
    sessionKey: string;
    sessionFile: string;
    mtimeMs: number;
  }> = [];
  for (const [mapKey, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) continue;
    const rawSessionFile =
      typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
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
    const transcriptMessages = await readTranscriptMessages(
      candidate.sessionFile,
    );
    const analysis = buildSelfNudgeAnalysisTranscript({
      messages: transcriptMessages,
      analyzedRecentMessageCount: input.analyzedRecentMessageCount,
    });
    if (!analysis) {
      continue;
    }
    const latestUserMessage = analysis.latestUserMessage;
    if (
      !latestUserMessage ||
      !canUseTranscriptForSelfNudge(
        candidate.sessionKey,
        latestUserMessage.text,
      )
    ) {
      continue;
    }
    transcripts.push({
      ...candidate,
      mtimeMs: computeAnalysisActivityMs(candidate.mtimeMs, analysis.messages),
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
    { timeoutMs: 5_000 },
  );
  if (hasActiveOpenclawRuntimeWork(sessionsPayload)) return null;
  const candidates = readRuntimeSessionCandidates(sessionsPayload);
  const transcripts: FreshestSessionTranscript[] = [];
  for (const candidate of candidates) {
    const historyPayload = await readRuntimeChatHistory(
      input.gateway,
      candidate.gatewaySessionKey,
      {
        limit: computeRuntimeHistoryScanLimit(input.analyzedRecentMessageCount),
      },
    );
    const messages = readRuntimeHistoryMessages(historyPayload);
    const analysis = buildSelfNudgeAnalysisTranscript({
      messages,
      analyzedRecentMessageCount: input.analyzedRecentMessageCount,
    });
    if (!analysis) continue;
    const latestUserMessage = analysis.latestUserMessage;
    if (
      !latestUserMessage ||
      !canUseTranscriptForSelfNudge(
        candidate.sessionKey,
        latestUserMessage.text,
      )
    ) {
      continue;
    }
    const activityMs = computeAnalysisActivityMs(
      candidate.updatedAtMs,
      analysis.messages,
    );
    transcripts.push({
      sessionKey: candidate.sessionKey,
      sessionFile: `gateway://chat.history/${candidate.gatewaySessionKey}`,
      mtimeMs: activityMs,
      messages: analysis.messages,
      latestUserMessage: analysis.latestUserMessage,
    });
  }
  transcripts.sort(compareSessionTranscriptsForNudge);
  return transcripts[0] ?? null;
}

export function hasActiveOpenclawRuntimeWork(payload: unknown): boolean {
  const sessions =
    isPlainObject(payload) && Array.isArray(payload.sessions)
      ? payload.sessions
      : [];
  return sessions.some((session) => {
    if (!isPlainObject(session)) return false;
    if (
      session.hasActiveRun === true ||
      session.active === true ||
      session.busy === true ||
      session.isActive === true
    ) {
      return true;
    }
    if (isPlainObject(session.activeRun)) return true;
    if (Array.isArray(session.activeRuns) && session.activeRuns.length > 0)
      return true;
    const status = readString(session.status)?.toLowerCase();
    return (
      status === "active" ||
      status === "in_progress" ||
      status === "pending" ||
      status === "queued" ||
      status === "running" ||
      status === "starting" ||
      status === "working"
    );
  });
}

export async function isOpenclawRuntimeIdle(input: {
  gateway: GatewayLike;
}): Promise<boolean> {
  const payload = await input.gateway.request(
    "sessions.list",
    { agentId: "main", limit: 50 },
    { timeoutMs: 5_000 },
  );
  return !hasActiveOpenclawRuntimeWork(payload);
}

export function buildSelfNudgeAnalysisTranscript(input: {
  messages: TranscriptMessage[];
  analyzedRecentMessageCount: number;
}): Pick<FreshestSessionTranscript, "messages" | "latestUserMessage"> | null {
  const latestUserMessage = findLatestUserRequestMessage(input.messages);
  if (!latestUserMessage) return null;
  const assistantMessagesAfterLatestUser = input.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.lineIndex > latestUserMessage.lineIndex &&
      !isRelaySelfNudgeNoticeMessage(message.text),
  );
  const maxAssistantMessages = Math.max(
    0,
    Math.trunc(input.analyzedRecentMessageCount),
  );
  const selectedAssistantMessages =
    maxAssistantMessages > 0
      ? assistantMessagesAfterLatestUser.slice(-maxAssistantMessages)
      : [];
  const latestUserRequest = {
    ...latestUserMessage,
    isLatestUserRequest: true as const,
  };
  return {
    latestUserMessage: latestUserRequest,
    messages: [latestUserRequest, ...selectedAssistantMessages],
  };
}

function computeAnalysisActivityMs(
  fallbackMs: number,
  messages: TranscriptMessage[],
): number {
  const timestamps = messages.flatMap((message) =>
    typeof message.timestampMs === "number" ? [message.timestampMs] : [],
  );
  if (timestamps.length === 0) return fallbackMs;
  return Math.max(...timestamps);
}

function computeRuntimeHistoryScanLimit(
  analyzedRecentMessageCount: number,
): number {
  const requested = Math.max(0, Math.trunc(analyzedRecentMessageCount));
  return Math.max(RUNTIME_HISTORY_SCAN_LIMIT, requested + 1);
}

function findLatestAssistantActivityAfterLatestUser(
  transcript: FreshestSessionTranscript,
): number | null {
  const latestUserLineIndex = transcript.latestUserMessage?.lineIndex;
  if (latestUserLineIndex == null) return null;
  let latestTimestampMs: number | null = null;
  for (const message of transcript.messages) {
    if (
      message.role !== "assistant" ||
      message.lineIndex <= latestUserLineIndex ||
      isRelaySelfNudgeNoticeMessage(message.text) ||
      typeof message.timestampMs !== "number"
    ) {
      continue;
    }
    latestTimestampMs =
      latestTimestampMs == null
        ? message.timestampMs
        : Math.max(latestTimestampMs, message.timestampMs);
  }
  return latestTimestampMs;
}

function canUseTranscriptForSelfNudge(
  sessionKey: string,
  latestUserText: string,
): boolean {
  const classification = classifySessionActivity({
    sessionKey,
    latestUserText,
  });
  if (classification === "external_user_chat") return true;
  return (
    classification === "status_nudge" &&
    isUserFacingRuntimeSessionKey(sessionKey)
  );
}

function compareSessionTranscriptsForNudge(
  a: FreshestSessionTranscript,
  b: FreshestSessionTranscript,
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

function readRuntimeSessionCandidates(
  payload: unknown,
): RuntimeSessionCandidate[] {
  const sessions =
    isPlainObject(payload) && Array.isArray(payload.sessions)
      ? payload.sessions
      : [];
  return sessions
    .flatMap((session): RuntimeSessionCandidate[] => {
      if (!isPlainObject(session)) return [];
      const gatewaySessionKey = readString(session.key);
      if (!gatewaySessionKey) return [];
      const sessionKey = normalizeSessionKey(gatewaySessionKey);
      if (!isUserFacingRuntimeSessionKey(sessionKey)) return [];
      const updatedAtMs =
        readTimestampMs(session.updatedAt) ??
        readTimestampMs(session.lastUserMessageAt);
      if (updatedAtMs == null) return [];
      return [{ gatewaySessionKey, sessionKey, updatedAtMs }];
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

async function readRuntimeChatHistory(
  gateway: GatewayLike,
  gatewaySessionKey: string,
  input: { limit: number },
): Promise<unknown> {
  try {
    return await gateway.request(
      "chat.history",
      {
        sessionKey: gatewaySessionKey,
        limit: input.limit,
        maxChars: MAX_MESSAGE_TEXT_LEN,
      },
      { timeoutMs: 5_000 },
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
      { timeoutMs: 5_000 },
    );
  }
}

function readRuntimeHistoryMessages(payload: unknown): TranscriptMessage[] {
  const messages =
    isPlainObject(payload) && Array.isArray(payload.messages)
      ? payload.messages
      : [];
  return messages.flatMap((message, index): TranscriptMessage[] => {
    if (!isPlainObject(message)) return [];
    const role =
      message.role === "user" || message.role === "assistant"
        ? message.role
        : null;
    if (!role) return [];
    if (role === "assistant" && isRelayOwnedRuntimeHistoryMessage(message))
      return [];
    const text = extractTextFromMessage(message).trim();
    if (!text) return [];
    const timestampMs = readFreshestMessageTimestampMs(message);
    return [
      typeof timestampMs === "number"
        ? { role, text, lineIndex: index, timestampMs }
        : { role, text, lineIndex: index },
    ];
  });
}

export async function findVisibleFinalityInOpenclawRuntimeHistory(input: {
  gateway: GatewayLike;
  sessionKey: string;
  afterMs?: number;
}): Promise<SelfNudgeVisibleFinalityEvidence | null> {
  const historyPayload = await readRuntimeChatHistory(
    input.gateway,
    input.sessionKey,
    {
      limit: RUNTIME_HISTORY_SCAN_LIMIT,
    },
  );
  const messages: unknown[] =
    isPlainObject(historyPayload) && Array.isArray(historyPayload.messages)
      ? historyPayload.messages
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isPlainObject(message) || message.role !== "assistant") continue;
    const timestampMs = readFreshestMessageTimestampMs(message);
    if (
      input.afterMs != null &&
      timestampMs != null &&
      timestampMs < input.afterMs
    )
      continue;
    const visibleText = readMessageToolSendText(message);
    if (!visibleText) continue;
    return {
      visibleText,
      ...(timestampMs != null ? { deliveredAtMs: timestampMs } : {}),
      deliveryKind: "final",
    };
  }
  return null;
}

function isUserFacingRuntimeSessionKey(sessionKey: string): boolean {
  if (
    !sessionKey ||
    sessionKey === "main" ||
    sessionKey === "global" ||
    sessionKey === "unknown"
  )
    return false;
  if (sessionKey.startsWith("agent:")) return false;
  return (
    sessionKey.startsWith("tg:") ||
    sessionKey.startsWith("telegram:direct:") ||
    sessionKey.startsWith("telegram:group:") ||
    sessionKey.startsWith("whatsapp:") ||
    sessionKey.startsWith("whatsapp-personal:") ||
    sessionKey.startsWith("webchat:") ||
    sessionKey.startsWith("direct:") ||
    sessionKey.startsWith("openclaw-direct:")
  );
}

function isStaleLatestUserMessage(
  message: TranscriptMessage,
  nowMs: number,
): boolean {
  if (typeof message.timestampMs !== "number") return false;
  return nowMs - message.timestampMs > MAX_SELF_NUDGE_LATEST_USER_AGE_MS;
}

export function computeSelfNudgeWaitMs(
  baseTimeoutMs: number,
  consecutiveNudges: number,
): number {
  return (
    Math.max(MIN_BASE_TIMEOUT_MS, Math.trunc(baseTimeoutMs)) *
    (Math.max(0, Math.trunc(consecutiveNudges)) + 1)
  );
}

export function formatStatusNudgeMessage(body?: string): string {
  void body;
  return STATUS_NUDGE_MESSAGE;
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
                ...(message.isLatestUserRequest
                  ? { isLatestUserRequest: true }
                  : {}),
              })),
            }),
          },
        ],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `OpenRouter nudge analysis failed: HTTP ${response.status}`,
    );
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

async function readTranscriptMessages(
  sessionFile: string,
): Promise<TranscriptMessage[]> {
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
    const role =
      message.role === "user" || message.role === "assistant"
        ? message.role
        : null;
    if (!role) return;
    const text = extractTextFromMessage(message).trim();
    if (!text) return;
    const timestampMs = extractMessageTimestampMs(parsed, message);
    messages.push(
      typeof timestampMs === "number"
        ? { role, text, lineIndex: index, timestampMs }
        : { role, text, lineIndex: index },
    );
  });
  return messages;
}

function extractMessageTimestampMs(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): number | undefined {
  return (
    parseTimestampMs(message.timestamp) ?? parseTimestampMs(record.timestamp)
  );
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

function readFreshestMessageTimestampMs(
  message: Record<string, unknown>,
): number | undefined {
  const timestamps = [
    readTimestampMs(message.createdAt),
    readTimestampMs(message.timestamp),
    readTimestampMs(message.updatedAt),
    readTimestampMs(message.editedAt),
    readTimestampMs(message.editDate),
  ].filter((value): value is number => typeof value === "number");
  if (timestamps.length === 0) return undefined;
  return Math.max(...timestamps);
}

function buildSelfNudgeSystemPrompt(): string {
  return [
    "You decide whether an OpenClaw agent should receive a self-nudge to continue active work.",
    "Inspect only the provided OpenClaw session transcript messages.",
    "The message with isLatestUserRequest=true is the latest real user request and is always the task to judge.",
    "Assistant messages are limited to the configured recent agent messages after that user request; ignore older work not shown.",
    "Evaluate in this order: first determine what concrete actions the assistant actually completed after the latest user request; then judge whether those actions make the request final.",
    "Return strict JSON with keys: shouldNudge, finalConfidence, reasonCode, reason.",
    "Set finalConfidence to an integer from 0 to 100: your confidence that the assistant's latest answer fully completes the latest user request.",
    "Set reasonCode to one of: final_answer, waiting_for_user, no_active_request, unknown.",
    "Set shouldNudge=false with reasonCode=final_answer only when the latest user request is fully complete.",
    "Set shouldNudge=false with reasonCode=waiting_for_user only when the assistant asked the user a necessary question.",
    "Set shouldNudge=false with reasonCode=no_active_request only when there is no user request to continue.",
    "Set shouldNudge=true when the assistant should continue without waiting for the user.",
    "Treat progress updates, partial outcomes, and explicitly remaining work as unfinished unless the latest user request only asked for that limited update.",
    "A final status line such as 'Status: 100% complete' is evidence to consider, but it is not authoritative; verify it against the latest real user request and the assistant's full answer.",
    "Do not write instructions for the agent and do not generate nudge text; the relay always sends a fixed status-nudge message.",
  ].join("\n");
}

function parseSelfNudgeDecision(raw: string): SelfNudgeDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    return {
      shouldNudge: true,
      statusNudgeMessage: null,
      finalConfidence: 0,
      reason: "model_returned_non_json",
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 0,
      reason: "model_returned_non_object",
    };
  }
  const finalConfidence = parseFinalConfidence(parsed.finalConfidence);
  const shouldNudge =
    parsed.shouldNudge === true &&
    finalConfidence <= FINAL_ANSWER_CONFIDENCE_THRESHOLD;
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  const reasonCode = parseSelfNudgeReasonCode(parsed.reasonCode);
  return {
    shouldNudge,
    statusNudgeMessage: null,
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

function parseSelfNudgeReasonCode(
  value: unknown,
): SelfNudgeDecision["reasonCode"] | undefined {
  return value === "final_answer" ||
    value === "waiting_for_user" ||
    value === "no_active_request" ||
    value === "unknown"
    ? value
    : undefined;
}

function isFinalAnswerDecision(decision: SelfNudgeDecision): boolean {
  return decision.finalConfidence > FINAL_ANSWER_CONFIDENCE_THRESHOLD;
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
    input.filePath ??
    path.join(
      input.stateDir,
      "agents",
      "main",
      "golem-workers",
      "relay-self-nudge-index.json",
    );
  const maxRecords = Math.max(100, Math.trunc(input.maxRecords ?? 5_000));
  let cache: { records: Record<string, SelfNudgeProcessedRecord> } | null =
    null;

  const load = async (): Promise<{
    records: Record<string, SelfNudgeProcessedRecord>;
  }> => {
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

  const save = async (store: {
    records: Record<string, SelfNudgeProcessedRecord>;
  }): Promise<void> => {
    const entries = Object.entries(store.records).sort(
      ([, a], [, b]) => b.analyzedAtMs - a.analyzedAtMs,
    );
    store.records = Object.fromEntries(entries.slice(0, maxRecords));
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(
      tempPath,
      `${JSON.stringify({ version: 1, records: store.records }, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    await fs.rename(tempPath, filePath);
  };

  return {
    get: async ({ sessionKey, userFingerprint }) => {
      const store = await load();
      return (
        store.records[processedRecordKey(sessionKey, userFingerprint)] ?? null
      );
    },
    markAnalyzed: async (record) => {
      const store = await load();
      const key = processedRecordKey(record.sessionKey, record.userFingerprint);
      store.records[key] = {
        ...record,
        finalNoticeSentAtMs:
          record.finalNoticeSentAtMs ??
          store.records[key]?.finalNoticeSentAtMs ??
          null,
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

function processedRecordKey(
  sessionKey: string,
  userFingerprint: string,
): string {
  return createHash("sha256")
    .update(`${sessionKey}\n${userFingerprint}`)
    .digest("hex");
}

function parseProcessedRecords(
  value: unknown,
): Record<string, SelfNudgeProcessedRecord> {
  const rawRecords =
    isPlainObject(value) && isPlainObject(value.records) ? value.records : {};
  const records: Record<string, SelfNudgeProcessedRecord> = {};
  for (const [key, rawRecord] of Object.entries(rawRecords)) {
    if (!isPlainObject(rawRecord)) continue;
    const sessionKey =
      typeof rawRecord.sessionKey === "string" ? rawRecord.sessionKey : "";
    const userFingerprint =
      typeof rawRecord.userFingerprint === "string"
        ? rawRecord.userFingerprint
        : "";
    const decision = parseStoredDecision(rawRecord.decision);
    const analyzedAtMs =
      typeof rawRecord.analyzedAtMs === "number"
        ? rawRecord.analyzedAtMs
        : null;
    const latestUserLineIndex =
      typeof rawRecord.latestUserLineIndex === "number"
        ? rawRecord.latestUserLineIndex
        : null;
    if (
      !sessionKey ||
      !userFingerprint ||
      !decision ||
      analyzedAtMs == null ||
      latestUserLineIndex == null
    ) {
      continue;
    }
    records[key] = {
      sessionKey,
      userFingerprint,
      analysisFingerprint:
        typeof rawRecord.analysisFingerprint === "string"
          ? rawRecord.analysisFingerprint
          : null,
      latestUserTimestampMs:
        typeof rawRecord.latestUserTimestampMs === "number"
          ? rawRecord.latestUserTimestampMs
          : null,
      latestUserLineIndex,
      decision,
      analyzedAtMs,
      finalNoticeSentAtMs:
        typeof rawRecord.finalNoticeSentAtMs === "number"
          ? rawRecord.finalNoticeSentAtMs
          : null,
    };
  }
  return records;
}

function parseStoredDecision(value: unknown): SelfNudgeDecision | null {
  if (!isPlainObject(value)) return null;
  const shouldNudge = value.shouldNudge === true;
  const statusNudgeMessage =
    typeof value.statusNudgeMessage === "string" &&
    value.statusNudgeMessage.trim()
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
  const choices: unknown[] =
    isPlainObject(payload) && Array.isArray(payload.choices)
      ? payload.choices
      : [];
  const choice = choices[0] ?? null;
  if (!isPlainObject(choice)) return null;
  const message = choice.message;
  if (!isPlainObject(message)) return null;
  return typeof message.content === "string" &&
    message.content.trim().length > 0
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
        if (part.type === "text" && typeof part.content === "string")
          return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

function readMessageToolSendText(
  message: Record<string, unknown>,
): string | null {
  const calls = collectToolCallObjects(message);
  for (const call of calls) {
    const name = readString(call.name) ?? readString(call.toolName);
    if (name !== "message") continue;
    const args =
      parseToolCallArguments(call.arguments) ??
      parseToolCallArguments(call.input);
    if (!args) continue;
    if (readString(args.action) !== "send") continue;
    const text = readString(args.message) ?? readString(args.text);
    if (text) return text;
  }
  return null;
}

function collectToolCallObjects(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((item) => collectToolCallObjects(item));
  const record = value as Record<string, unknown>;
  const type = readString(record.type);
  const name = readString(record.name) ?? readString(record.toolName);
  const ownCall =
    name &&
    (type === "toolCall" ||
      type === "function_call" ||
      "arguments" in record ||
      "input" in record)
      ? [record]
      : [];
  const nested = [
    record.content,
    record.toolCall,
    record.tool_calls,
    record.toolCalls,
  ].flatMap((item) => collectToolCallObjects(item));
  return [...ownCall, ...nested];
}

function parseToolCallArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findLatestUserRequestMessage(
  messages: TranscriptMessage[],
): TranscriptMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message?.role === "user" &&
      !isIgnoredSelfNudgeUserMessage(message.text)
    )
      return message;
  }
  return null;
}

function isIgnoredSelfNudgeUserMessage(text: string): boolean {
  const normalized = text.trimStart();
  return (
    isStatusNudgeMessage(normalized) ||
    isPreCompactionMemoryFlushMessage(normalized)
  );
}

function isStatusNudgeMessage(text: string): boolean {
  return text.trimStart().startsWith(STATUS_NUDGE_MARKER);
}

function isPreCompactionMemoryFlushMessage(text: string): boolean {
  return (
    /^Pre-compaction memory flush\./i.test(text) &&
    /Store durable memories only in memory\//i.test(text)
  );
}

function findFinalAssistantMessage(
  transcript: FreshestSessionTranscript,
): TranscriptMessage | null {
  const latestUserLineIndex = transcript.latestUserMessage?.lineIndex ?? -1;
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (
      message?.role === "assistant" &&
      message.lineIndex > latestUserLineIndex &&
      !isRelaySelfNudgeNoticeMessage(message.text)
    ) {
      return message;
    }
  }
  for (let index = transcript.messages.length - 1; index >= 0; index -= 1) {
    const message = transcript.messages[index];
    if (
      message?.role === "assistant" &&
      !isRelaySelfNudgeNoticeMessage(message.text)
    ) {
      return message;
    }
  }
  return null;
}

function isRelaySelfNudgeNoticeMessage(text: string): boolean {
  const normalized = text.trimStart();
  return (
    /^TURN_FINAL:\s/.test(normalized) ||
    /^FINAL\(\d+%\):\s/.test(normalized) ||
    /^NUDGE\(\d+% final\):\s/.test(normalized)
  );
}

function isRelayOwnedRuntimeHistoryMessage(
  message: Record<string, unknown>,
): boolean {
  const text = extractTextFromMessage(message).trim();
  if (text && isRelaySelfNudgeNoticeMessage(text)) return true;

  const metadata = isPlainObject(message.__openclaw) ? message.__openclaw : {};
  const identifiers = [
    message.id,
    message.idempotencyKey,
    metadata.id,
    metadata.messageId,
  ].flatMap((value) => (typeof value === "string" ? [value.trim()] : []));
  return identifiers.some((value) => value.startsWith("system-notification:"));
}

function makeFinalNoticePreview(text: string): string {
  return makeNoticePreview(text, 10);
}

function makeNoticePreview(text: string, maxLength = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const preview = normalized.slice(0, maxLength);
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
  const stablePosition =
    typeof message.timestampMs === "number"
      ? `ts:${message.timestampMs}`
      : `line:${message.lineIndex}`;
  return createHash("sha256")
    .update(`${stablePosition}\n${message.role}\n${message.text}`)
    .digest("hex");
}

function fingerprintAnalysisMessages(messages: TranscriptMessage[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        messages.map((message) => ({
          role: message.role,
          text: message.text,
          lineIndex: message.lineIndex,
          timestampMs: message.timestampMs ?? null,
          isLatestUserRequest: message.isLatestUserRequest === true,
        })),
      ),
    )
    .digest("hex");
}

function normalizeOpenRouterModel(model: string | null): string {
  const raw = model?.trim() || DEFAULT_NUDGE_MODEL;
  return raw.toLowerCase().startsWith("openrouter/")
    ? raw.slice("openrouter/".length)
    : raw;
}

function normalizeSessionKey(mapKey: string): string {
  return mapKey.startsWith("agent:main:")
    ? mapKey.slice("agent:main:".length)
    : mapKey;
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
