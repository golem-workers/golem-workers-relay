import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { classifySessionActivity } from "../conversation/activityIndex.js";
import type { ChatRunner, ChatSendOriginRoute } from "./chatRunner.js";

export const STATUS_NUDGE_MARKER = "[STATUS_NUDGE]";

const DEFAULT_NUDGE_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DISABLED_POLL_INTERVAL_MS = 30_000;
const MIN_BASE_TIMEOUT_MS = 1_000;
const MAX_MESSAGE_TEXT_LEN = 4_000;

export type RelaySelfNudgeSettings = {
  enabled: boolean;
  analyzedRecentMessageCount: number;
  baseTimeoutMs: number;
  model: string | null;
  finalNoticeEnabled: boolean;
  finalNoticeText: string;
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  lineIndex: number;
  timestampMs?: number;
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
  reasonCode?: "final_answer" | "waiting_for_user" | "no_active_request" | "unknown";
  reason?: string;
};

type RunnerLike = Pick<ChatRunner, "runChatTask">;

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
  nowMs: number;
}): string {
  const finalMessage = findFinalAssistantMessage(input.transcript) ?? input.transcript.latestUserMessage;
  const preview = makeFinalNoticePreview(finalMessage?.text ?? "");
  const timeText = formatNoticeTime(finalMessage?.timestampMs ?? input.nowMs);
  return `FINAL: message "${preview}" from ${timeText} is final`;
}

export function createSelfNudgeRunner(input: {
  settings: RelaySelfNudgeSettings;
  stateDir?: string;
  runner: RunnerLike;
  openrouterProxyPort: number;
  openrouterProxyPathPrefix: string;
  systemTaskTimeoutMs: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  processedStore?: SelfNudgeProcessedStore;
  notifyFinalDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
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
      const transcript = await readFreshestSessionTranscript({
        stateDir: input.stateDir ?? resolveOpenclawStateDir(),
        analyzedRecentMessageCount: settings.analyzedRecentMessageCount,
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
        runner: input.runner,
        systemTaskTimeoutMs: input.systemTaskTimeoutMs,
        processedStore,
        notifyFinalDecision: input.notifyFinalDecision,
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
  runner: RunnerLike;
  systemTaskTimeoutMs: number;
  processedStore?: SelfNudgeProcessedStore;
  notifyFinalDecision?: (input: {
    transcript: FreshestSessionTranscript;
    decision: SelfNudgeDecision;
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
  await input.runner.runChatTask({
    taskId: `self_nudge_${randomUUID()}`,
    sessionKey: input.transcript.sessionKey,
    messageText: formatStatusNudgeMessage(body),
    deliverySystem: "relay_channel_v2",
    originRoute: buildSelfNudgeOriginRoute(input.transcript.sessionKey),
    timeoutMs: input.systemTaskTimeoutMs,
  });
  input.state.consecutiveNudges += 1;
  input.state.lastNudgeAtMs = input.nowMs;
  return {
    nudged: true,
    nextDelayMs: computeSelfNudgeWaitMs(input.settings.baseTimeoutMs, input.state.consecutiveNudges),
  };
}

function buildSelfNudgeOriginRoute(sessionKey: string): ChatSendOriginRoute | null {
  if (sessionKey.startsWith("tg:")) {
    const chatId = sessionKey.slice("tg:".length).split(":")[0]?.trim();
    return chatId
      ? {
          originatingChannel: "relay-channel",
          originatingTo: `telegram:${chatId}`,
        }
      : null;
  }

  if (sessionKey.startsWith("whatsapp-personal:")) {
    const chatId = sessionKey.slice("whatsapp-personal:".length).split(":")[0]?.trim();
    return chatId
      ? {
          originatingChannel: "relay-channel",
          originatingTo: `whatsapp_personal:${chatId}`,
        }
      : null;
  }

  return null;
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
    const latestUserMessage = findLatestUserMessage(transcriptMessages);
    if (!latestUserMessage) continue;
    if (
      classifySessionActivity({
        sessionKey: candidate.sessionKey,
        latestUserText: latestUserMessage.text,
      }) !== "external_user_chat"
    ) {
      continue;
    }
    transcripts.push({
      ...candidate,
      messages: transcriptMessages.slice(-Math.max(1, input.analyzedRecentMessageCount + 1)),
      latestUserMessage,
    });
  }
  transcripts.sort(compareSessionTranscriptsForNudge);
  return transcripts[0] ?? null;
}

function compareSessionTranscriptsForNudge(
  a: FreshestSessionTranscript,
  b: FreshestSessionTranscript
): number {
  const aLatestUserMs = a.latestUserMessage?.timestampMs ?? a.mtimeMs;
  const bLatestUserMs = b.latestUserMessage?.timestampMs ?? b.mtimeMs;
  return bLatestUserMs - aLatestUserMs || b.mtimeMs - a.mtimeMs;
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

function buildSelfNudgeSystemPrompt(): string {
  return [
    "You decide whether an OpenClaw agent should receive a self-nudge to continue active work.",
    "Inspect only the provided OpenClaw session transcript messages.",
    "Return strict JSON with keys: shouldNudge, statusNudgeMessage, reasonCode, reason.",
    "Set reasonCode to one of: final_answer, waiting_for_user, no_active_request, unknown.",
    "Set shouldNudge=true only when the latest user request appears unfinished, blocked by no external user input, or the assistant was still actively working.",
    "Set shouldNudge=false with reasonCode=final_answer when the assistant clearly completed the request.",
    "Set shouldNudge=false with reasonCode=waiting_for_user when the assistant asked the user a necessary question.",
    "Set shouldNudge=false with reasonCode=no_active_request when there is no user request to continue.",
    "When shouldNudge=true, statusNudgeMessage must be a concise imperative message for the agent to continue the in-flight task and report new evidence.",
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
      reason: "model_returned_non_json",
    };
  }
  if (!isPlainObject(parsed)) {
    return { shouldNudge: false, statusNudgeMessage: null, reason: "model_returned_non_object" };
  }
  const shouldNudge = parsed.shouldNudge === true;
  const statusNudgeMessage =
    typeof parsed.statusNudgeMessage === "string" && parsed.statusNudgeMessage.trim().length > 0
      ? parsed.statusNudgeMessage.trim()
      : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  const reasonCode = parseSelfNudgeReasonCode(parsed.reasonCode);
  return {
    shouldNudge,
    statusNudgeMessage: shouldNudge ? normalizeNudgeBody(statusNudgeMessage) : null,
    ...(reasonCode ? { reasonCode } : {}),
    reason,
  };
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
  if (decision.reasonCode === "final_answer") return true;
  if (decision.reasonCode) return false;
  const reason = decision.reason?.toLowerCase() ?? "";
  return /\b(final|complete|completed|done|finished|answered)\b/.test(reason);
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
    ...(reasonCode ? { reasonCode } : {}),
    reason,
  };
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
