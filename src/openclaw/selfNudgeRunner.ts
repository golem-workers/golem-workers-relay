import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import type { ChatRunner } from "./chatRunner.js";

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
};

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  lineIndex: number;
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
  reason?: string;
};

type RunnerLike = Pick<ChatRunner, "runChatTask">;

export type SelfNudgeState = {
  sessionKey: string | null;
  latestUserFingerprint: string | null;
  consecutiveNudges: number;
  lastNudgeAtMs: number | null;
};

export type SelfNudgeRunner = {
  start: () => void;
  stop: () => void;
  tick: (nowMs?: number) => Promise<void>;
};

export function createSelfNudgeRunner(input: {
  settings: RelaySelfNudgeSettings;
  stateDir?: string;
  runner: RunnerLike;
  openrouterProxyPort: number;
  openrouterProxyPathPrefix: string;
  systemTaskTimeoutMs: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}): SelfNudgeRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  const state: SelfNudgeState = {
    sessionKey: null,
    latestUserFingerprint: null,
    consecutiveNudges: 0,
    lastNudgeAtMs: null,
  };
  const pollIntervalMs = Math.max(1_000, Math.trunc(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));

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
  }

  const waitMs = computeSelfNudgeWaitMs(input.settings.baseTimeoutMs, input.state.consecutiveNudges);
  const anchorMs = input.state.lastNudgeAtMs ?? input.transcript.mtimeMs;
  const elapsedMs = input.nowMs - anchorMs;
  if (elapsedMs < waitMs) {
    return { nudged: false, nextDelayMs: waitMs - elapsedMs };
  }

  const decision = await input.decide({
    settings: input.settings,
    transcript: input.transcript,
  });
  if (!decision.shouldNudge) {
    return { nudged: false, nextDelayMs: input.settings.baseTimeoutMs };
  }

  const body = normalizeNudgeBody(decision.statusNudgeMessage);
  await input.runner.runChatTask({
    taskId: `self_nudge_${randomUUID()}`,
    sessionKey: input.transcript.sessionKey,
    messageText: formatStatusNudgeMessage(body),
    deliverySystem: "relay_channel_v2",
    timeoutMs: input.systemTaskTimeoutMs,
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
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const freshest = candidates[0];
  if (!freshest) return null;

  const transcriptMessages = await readTranscriptMessages(freshest.sessionFile);
  const messages = transcriptMessages.slice(-Math.max(1, input.analyzedRecentMessageCount + 1));
  const latestUserMessage = findLatestUserMessage(transcriptMessages);
  return {
    ...freshest,
    messages,
    latestUserMessage,
  };
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
    messages.push({ role, text, lineIndex: index });
  });
  return messages;
}

function buildSelfNudgeSystemPrompt(): string {
  return [
    "You decide whether an OpenClaw agent should receive a self-nudge to continue active work.",
    "Inspect only the provided OpenClaw session transcript messages.",
    "Return strict JSON with keys: shouldNudge, statusNudgeMessage, reason.",
    "Set shouldNudge=true only when the latest user request appears unfinished, blocked by no external user input, or the assistant was still actively working.",
    "Set shouldNudge=false when the assistant clearly completed the request, asked the user a necessary question, or there is no user request to continue.",
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
  return {
    shouldNudge,
    statusNudgeMessage: shouldNudge ? normalizeNudgeBody(statusNudgeMessage) : null,
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
