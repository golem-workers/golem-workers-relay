import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { logger } from "../logger.js";
import type { BackendClient } from "../backend/backendClient.js";
import type { InboundPushMessage } from "../backend/types.js";
import type { ConversationActivityIndex } from "../conversation/activityIndex.js";
import { deliverSystemNotificationFromRelay } from "../conversation/systemNotificationDelivery.js";

const execFileAsync = promisify(execFile);

export type RelayDiagnosticNotifierSettings = {
  enabled: boolean;
  intervalMs: number;
  lookbackMs: number;
  throttleMs: number;
  maxLines: number;
  journalUserUnits: string[];
  journalSystemUnits: string[];
  logFiles: string[];
  targetUserId: string | null;
};

export type DiagnosticLogLine = {
  source: string;
  text: string;
};

export type DiagnosticIssueCode =
  | "relay_auth"
  | "compaction_failure"
  | "openclaw_turn_timeout";

export type DiagnosticIssue = {
  code: DiagnosticIssueCode;
  title: string;
  severity: "warning" | "error" | "critical";
  count: number;
  sources: string[];
  examples: string[];
  fingerprints: string[];
};

export type DiagnosticAnalysis = {
  issueCount: number;
  issues: DiagnosticIssue[];
};

type RelayDiagnosticNotifierInput = {
  settings: RelayDiagnosticNotifierSettings;
  backend: BackendClient;
  activityIndex: ConversationActivityIndex;
  relayInstanceId: string;
  collectLogs?: () => Promise<DiagnosticLogLine[]>;
  now?: () => number;
};

const issueMatchers: Array<{
  code: DiagnosticIssueCode;
  title: string;
  severity: DiagnosticIssue["severity"];
  patterns: RegExp[];
}> = [
  {
    code: "compaction_failure",
    title: "Context compaction failed",
    severity: "error",
    patterns: [/context-engine compaction failed/i, /compaction summarization failed/i, /Auto-compaction could not recover/i],
  },
  {
    code: "relay_auth",
    title: "Relay authorization failed",
    severity: "error",
    patterns: [/RELAY_UNAUTHORIZED/i, /Invalid relay token/i, /Failed to extract accountId from token/i],
  },
  {
    code: "openclaw_turn_timeout",
    title: "OpenClaw turn timed out",
    severity: "warning",
    patterns: [/codex app-server turn idle timed out/i, /turn idle timed out waiting for completion/i],
  },
];

export function analyzeDiagnosticLogs(lines: DiagnosticLogLine[]): DiagnosticAnalysis {
  const byCode = new Map<DiagnosticIssueCode, DiagnosticIssue>();
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    if (isIgnoredDiagnosticLogLine(text)) continue;
    const matcher = issueMatchers.find((candidate) => candidate.patterns.some((pattern) => pattern.test(text)));
    if (!matcher) continue;
    const issue = byCode.get(matcher.code) ?? {
      code: matcher.code,
      title: matcher.title,
      severity: matcher.severity,
      count: 0,
      sources: [],
      examples: [],
      fingerprints: [],
    };
    issue.count += 1;
    if (!issue.sources.includes(line.source)) {
      issue.sources.push(line.source);
    }
    const example = sanitizeLogLine(text);
    if (example && issue.examples.length < 2 && !issue.examples.includes(example)) {
      issue.examples.push(example);
    }
    const fingerprint = normalizeLogFingerprint(line.source, text);
    if (fingerprint && !issue.fingerprints.includes(fingerprint)) {
      issue.fingerprints.push(fingerprint);
    }
    byCode.set(matcher.code, issue);
  }
  const issues = [...byCode.values()].sort(compareIssues);
  return {
    issueCount: issues.reduce((sum, issue) => sum + issue.count, 0),
    issues,
  };
}

export function formatDiagnosticNotification(input: {
  analysis: DiagnosticAnalysis;
  lookbackMs: number;
  relayInstanceId: string;
}): string {
  const windowMinutes = Math.max(1, Math.round(input.lookbackMs / 60_000));
  const issueSummary = input.analysis.issues
    .slice(0, 5)
    .map((issue) => `${issue.title} x${issue.count}`)
    .join("; ");
  return `====== DIAGNOSTIC ======\n${issueSummary} in the last ${windowMinutes}m.`;
}

export function createRelayDiagnosticNotifier(input: RelayDiagnosticNotifierInput): {
  start: () => void;
  stop: () => void;
  runOnce: () => Promise<void>;
} {
  const now = input.now ?? (() => Date.now());
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const lastSentAtByFingerprint = new Map<string, number>();
  const collectLogs =
    input.collectLogs ??
    (() =>
      collectDiagnosticLogs({
        settings: input.settings,
        sinceMs: now() - input.settings.lookbackMs,
      }));

  async function runOnce(): Promise<void> {
    if (!input.settings.enabled || running) return;
    running = true;
    try {
      const logs = await collectLogs();
      const analysis = analyzeDiagnosticLogs(logs.slice(-input.settings.maxLines));
      if (analysis.issueCount === 0) return;
      const fingerprint = analysis.issues
        .map((issue) => `${issue.code}:${issue.fingerprints.slice().sort().join(",") || issue.count}`)
        .join("|");
      const previousSentAt = lastSentAtByFingerprint.get(fingerprint);
      const currentTime = now();
      if (previousSentAt != null && currentTime - previousSentAt < input.settings.throttleMs) {
        return;
      }
      const route = input.activityIndex.findBestUserVisibleRoute({
        ...(input.settings.targetUserId ? { userId: input.settings.targetUserId } : {}),
        now: currentTime,
      });
      if (!route) {
        logger.warn(
          {
            event: "relay_diagnostics",
            stage: "notification_not_delivered",
            status: "no_route",
            issueCount: analysis.issueCount,
          },
          "Relay diagnostics notification had no user-visible route"
        );
        return;
      }
      const message = buildDiagnosticNotificationMessage({
        settings: input.settings,
        analysis,
        relayInstanceId: input.relayInstanceId,
        nowMs: currentTime,
        userId: input.settings.targetUserId ?? route.userId ?? "relay-diagnostics",
      });
      const result = await deliverSystemNotificationFromRelay({
        backend: input.backend,
        activityIndex: input.activityIndex,
        message,
      });
      if (result.status === "delivered") {
        lastSentAtByFingerprint.set(fingerprint, currentTime);
        logger.warn(
          {
            event: "relay_diagnostics",
            stage: "notified",
            issueCount: analysis.issueCount,
            issueCodes: analysis.issues.map((issue) => issue.code),
            selectedChannel: result.selectedChannel,
            sessionKey: result.sessionKey,
          },
          "Relay diagnostics notification delivered"
        );
      } else {
        logger.warn(
          {
            event: "relay_diagnostics",
            stage: "notification_not_delivered",
            status: result.status,
            error: result.error,
          },
          "Relay diagnostics notification was not delivered"
        );
      }
    } catch (error) {
      logger.warn(
        {
          event: "relay_diagnostics",
          stage: "run_failed",
          error: error instanceof Error ? error.message : String(error),
        },
        "Relay diagnostics notifier failed"
      );
    } finally {
      running = false;
    }
  }

  return {
    start: () => {
      if (!input.settings.enabled || timer) return;
      logger.info(
        {
          event: "relay_diagnostics",
          intervalMs: input.settings.intervalMs,
          lookbackMs: input.settings.lookbackMs,
          throttleMs: input.settings.throttleMs,
          journalUserUnits: input.settings.journalUserUnits,
          journalSystemUnits: input.settings.journalSystemUnits,
          logFiles: input.settings.logFiles,
        },
        "Relay diagnostics notifier enabled"
      );
      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, input.settings.intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}

export async function collectDiagnosticLogs(input: {
  settings: RelayDiagnosticNotifierSettings;
  sinceMs: number;
}): Promise<DiagnosticLogLine[]> {
  const chunks = await Promise.all([
    ...input.settings.journalUserUnits.map((unit) => readJournalUnit({ scope: "user", unit, sinceMs: input.sinceMs })),
    ...input.settings.journalSystemUnits.map((unit) =>
      readJournalUnit({ scope: "system", unit, sinceMs: input.sinceMs })
    ),
    ...input.settings.logFiles.map((filePath) => readLogFile({ filePath, maxLines: input.settings.maxLines })),
  ]);
  return chunks.flat().slice(-input.settings.maxLines);
}

function buildDiagnosticNotificationMessage(input: {
  settings: RelayDiagnosticNotifierSettings;
  analysis: DiagnosticAnalysis;
  relayInstanceId: string;
  nowMs: number;
  userId: string;
}): InboundPushMessage {
  const notificationId = `relay-diagnostics:${input.relayInstanceId}:${input.nowMs}`;
  return {
    messageId: `system-notification:${notificationId}`,
    sentAtMs: input.nowMs,
    input: {
      kind: "system_notification",
      notificationId,
      userId: input.userId,
      text: formatDiagnosticNotification({
        analysis: input.analysis,
        lookbackMs: input.settings.lookbackMs,
        relayInstanceId: input.relayInstanceId,
      }),
      eventKey: `relay.diagnostics.${input.analysis.issues[0]?.code ?? "error"}`,
      code: "relay:diagnostics:error",
      severity: highestSeverity(input.analysis),
      rawTaskResult: {
        relayInstanceId: input.relayInstanceId,
        issues: input.analysis.issues.map((issue) => ({
          code: issue.code,
          count: issue.count,
          sources: issue.sources,
        })),
      },
    },
  };
}

async function readJournalUnit(input: {
  scope: "user" | "system";
  unit: string;
  sinceMs: number;
}): Promise<DiagnosticLogLine[]> {
  const sinceSeconds = Math.floor(input.sinceMs / 1000);
  const args = [
    ...(input.scope === "user" ? ["--user"] : []),
    "-u",
    input.unit,
    `--since=@${sinceSeconds}`,
    "--no-pager",
    "-o",
    "cat",
  ];
  try {
    const { stdout } = await execFileAsync("journalctl", args, {
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    return splitLines(stdout).map((text) => ({ source: `${input.scope}:${input.unit}`, text }));
  } catch (error) {
    logger.warn(
      {
        event: "relay_diagnostics",
        stage: "journal_read_failed",
        scope: input.scope,
        unit: input.unit,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to read diagnostics journal source"
    );
    return [];
  }
}

async function readLogFile(input: {
  filePath: string;
  maxLines: number;
}): Promise<DiagnosticLogLine[]> {
  try {
    const raw = await fs.readFile(input.filePath, "utf8");
    return splitLines(raw)
      .slice(-input.maxLines)
      .map((text) => ({ source: input.filePath, text }));
  } catch (error) {
    logger.warn(
      {
        event: "relay_diagnostics",
        stage: "log_file_read_failed",
        filePath: input.filePath,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to read diagnostics log source"
    );
    return [];
  }
}

function compareIssues(a: DiagnosticIssue, b: DiagnosticIssue): number {
  const severityDelta = severityRank(b.severity) - severityRank(a.severity);
  if (severityDelta !== 0) return severityDelta;
  return b.count - a.count;
}

function severityRank(severity: DiagnosticIssue["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "error") return 2;
  return 1;
}

function highestSeverity(analysis: DiagnosticAnalysis): DiagnosticIssue["severity"] {
  return analysis.issues.reduce<DiagnosticIssue["severity"]>((current, issue) => {
    return severityRank(issue.severity) > severityRank(current) ? issue.severity : current;
  }, "warning");
}

function sanitizeLogLine(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(token|password|authorization)=\S+/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isIgnoredDiagnosticLogLine(value: string): boolean {
  return [
    /^Stopping golem-workers-relay\.service\b/i,
    /^Stopped golem-workers-relay\.service\b/i,
    /^Started golem-workers-relay\.service\b/i,
    /^golem-workers-relay\.service: Deactivated successfully\b/i,
    /^golem-workers-relay\.service: State 'final-sigterm' timed out\. Killing\./i,
    /^golem-workers-relay\.service: Killing process \d+ /i,
    /^golem-workers-relay\.service: Failed with result 'timeout'\./i,
    /"msg":"Stop signal received; draining relay queue"/i,
    /"msg":"Relay stopped"/i,
    /Gateway connection lost while waiting for run .*Gateway client stopped/i,
    /"msg":"Relay-channel (data|control) plane listening"/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeLogFingerprint(source: string, value: string): string {
  return `${source}:${sanitizeLogLine(value)
    .replace(/"time":\d+/g, '"time":<n>')
    .replace(/"pid":\d+/g, '"pid":<n>')
    .replace(/pid=\d+/gi, "pid=<n>")
    .replace(/\bprocess \d+\b/gi, "process <n>")
    .replace(/\brelay_[a-f0-9-]+\b/gi, "relay_<id>")
    .replace(/\b[0-9a-f]{24,}\b/gi, "<hex>")
    .replace(/\b\d{10,}\b/g, "<n>")
    .trim()}`;
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
