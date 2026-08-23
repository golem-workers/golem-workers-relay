import fs from "node:fs/promises";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";

import {
  buildCronInventoryConfigHash,
  CRON_INVENTORY_MAX_BYTES,
  CRON_INVENTORY_MAX_JOBS,
  type CronInventoryCollectionError,
  type CronInventoryEntry,
  type CronInventorySnapshot,
  cronInventorySnapshotSchema,
  sha256Fingerprint,
} from "./contract.js";

const SYSTEM_CRON_MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

type GatewayLike = {
  request(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
};

export type CronInventoryCollector = {
  collect(input?: { requestId?: string }): Promise<CronInventorySnapshot>;
};

export function createCronInventoryCollector(input: {
  gateway: GatewayLike;
  collectorVersion: string;
  now?: () => Date;
  paths?: {
    etcCrontab?: string;
    cronD?: string;
    spool?: string[];
  };
}): CronInventoryCollector {
  const now = input.now ?? (() => new Date());
  return {
    async collect(options) {
      const observedAt = now();
      const [openclaw, system] = await Promise.all([
        collectOpenclawEntries(input.gateway, observedAt),
        collectSystemEntries(observedAt, input.paths),
      ]);
      const allJobs = [...openclaw.entries, ...system.entries];
      const truncated = allJobs.length > CRON_INVENTORY_MAX_JOBS;
      let errors = [
        ...openclaw.errors,
        ...system.errors,
        ...(truncated
          ? [{
              source: "OPENCLAW" as const,
              code: "parseError" as const,
              message: `Cron inventory exceeded ${CRON_INVENTORY_MAX_JOBS} jobs and was truncated`,
            }]
          : []),
      ];
      let jobs = allJobs.slice(0, CRON_INVENTORY_MAX_JOBS);
      const successfulSources = Number(openclaw.success) + Number(system.success);
      let collectionStatus: CronInventorySnapshot["collectionStatus"] =
        successfulSources === 2 && !truncated
          ? "COMPLETE"
          : successfulSources === 0
            ? "FAILED"
            : "PARTIAL";
      const buildSnapshot = () => ({
        schemaVersion: 1 as const,
        collectorVersion: input.collectorVersion,
        observedAt: observedAt.toISOString(),
        configHash: buildCronInventoryConfigHash(jobs),
        collectionStatus,
        errors: errors.slice(0, 500),
        ...(options?.requestId ? { requestId: options.requestId } : {}),
        jobs,
      });
      let snapshot = buildSnapshot();
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CRON_INVENTORY_MAX_BYTES) {
        collectionStatus = successfulSources === 0 ? "FAILED" : "PARTIAL";
        errors = [{
          source: "OPENCLAW",
          code: "parseError",
          message: `Cron inventory exceeded ${CRON_INVENTORY_MAX_BYTES} bytes and was truncated`,
        }, ...errors];
        do {
          jobs = jobs.slice(
            0,
            Math.max(0, jobs.length - Math.max(1, Math.ceil(jobs.length / 10))),
          );
          snapshot = buildSnapshot();
        } while (
          jobs.length > 0 &&
          Buffer.byteLength(JSON.stringify(snapshot), "utf8") > CRON_INVENTORY_MAX_BYTES
        );
      }
      return cronInventorySnapshotSchema.parse(snapshot);
    },
  };
}

async function collectOpenclawEntries(
  gateway: GatewayLike,
  observedAt: Date,
): Promise<{
  success: boolean;
  entries: CronInventoryEntry[];
  errors: CronInventoryCollectionError[];
}> {
  try {
    const jobs: unknown[] = [];
    let offset = 0;
    let truncated = false;
    for (;;) {
      const response = asRecord(
        await gateway.request(
          "cron.list",
          { includeDisabled: true, limit: 200, offset },
          { timeoutMs: 30_000 },
        ),
      );
      const page: unknown[] = Array.isArray(response.jobs)
        ? (response.jobs as unknown[])
        : [];
      jobs.push(...page);
      const nextOffset = readNumber(response.nextOffset);
      const hasMore = response.hasMore === true;
      if (!hasMore && nextOffset === null) break;
      const resolvedNext = nextOffset ?? offset + page.length;
      if (resolvedNext <= offset || page.length === 0) break;
      offset = resolvedNext;
      if (jobs.length >= CRON_INVENTORY_MAX_JOBS) {
        truncated = hasMore || nextOffset !== null;
        break;
      }
    }
    return {
      success: !truncated,
      entries: jobs
        .slice(0, CRON_INVENTORY_MAX_JOBS)
        .map((job) => buildOpenclawEntry(job, observedAt)),
      errors: truncated
        ? [{
            source: "OPENCLAW",
            code: "parseError",
            message: `OpenClaw cron inventory exceeded ${CRON_INVENTORY_MAX_JOBS} jobs and was truncated`,
          }]
        : [],
    };
  } catch (error) {
    return {
      success: false,
      entries: [],
      errors: [
        {
          source: "OPENCLAW",
          code: "sourceUnavailable",
          message: normalizeError(error),
        },
      ],
    };
  }
}

function buildOpenclawEntry(value: unknown, observedAt: Date): CronInventoryEntry {
  const job = asRecord(value);
  const id = readString(job.id) ?? `invalid:${sha256Fingerprint(job).slice(-24)}`;
  const name = readRedactedString(job.name) ?? id;
  const schedule = readOpenclawSchedule(job.schedule);
  let parseStatus: CronInventoryEntry["parseStatus"] = "SUPPORTED";
  let parseError: string | null = null;
  try {
    validateSchedule(schedule, observedAt);
  } catch (error) {
    parseStatus = schedule.kind === "unsupported" ? "UNSUPPORTED" : "INVALID";
    parseError = normalizeError(error);
  }
  const safeJob = {
    id,
    name,
    description: readRedactedString(job.description, 2_000),
    enabled: job.enabled === true,
    deleteAfterRun: job.deleteAfterRun === true,
    agentId: null,
    sessionKey: null,
    createdAtMs: readNonnegativeInteger(job.createdAtMs) ?? 0,
    updatedAtMs: readNonnegativeInteger(job.updatedAtMs) ?? 0,
    schedule,
    sessionTarget: readString(job.sessionTarget) ?? "unknown",
    wakeMode: readString(job.wakeMode) ?? "unknown",
    payload: sanitizePayload(job.payload),
    delivery: sanitizeDelivery(job.delivery),
    failureAlert: sanitizeFailureAlert(job.failureAlert),
    state: sanitizeRuntime(job.state),
  };
  const rawConfig = {
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    schedule: job.schedule,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payload: job.payload,
    delivery: job.delivery,
    failureAlert: job.failureAlert,
  };
  return {
    source: "OPENCLAW",
    sourceId: id,
    name,
    description: safeJob.description,
    enabled: safeJob.enabled,
    schedule,
    timezone: schedule.kind === "cron" ? schedule.tz : null,
    nextRunAtMs: safeJob.state.nextRunAtMs,
    parseStatus,
    parseError,
    configFingerprint: sha256Fingerprint(rawConfig),
    openclawJob: safeJob,
  };
}

function readOpenclawSchedule(value: unknown): CronInventoryEntry["schedule"] {
  const schedule = asRecord(value);
  if (schedule.kind === "at" && typeof schedule.at === "string") {
    return { kind: "at", at: schedule.at.slice(0, 200) };
  }
  if (schedule.kind === "every") {
    const everyMs = readNonnegativeInteger(schedule.everyMs);
    if (everyMs && everyMs > 0) {
      return {
        kind: "every",
        everyMs,
        anchorMs: readNonnegativeInteger(schedule.anchorMs),
      };
    }
  }
  if (schedule.kind === "cron" && typeof schedule.expr === "string") {
    return {
      kind: "cron",
      expr: schedule.expr.slice(0, 500),
      tz: readString(schedule.tz),
      staggerMs: readNonnegativeInteger(schedule.staggerMs),
    };
  }
  return { kind: "unsupported", fingerprint: sha256Fingerprint(schedule) };
}

function sanitizePayload(value: unknown) {
  const payload = asRecord(value);
  return {
    kind: readString(payload.kind) ?? "unknown",
    contentFingerprint: sha256Fingerprint(payload),
    model: readRedactedString(payload.model),
    fallbacks: readStringArray(payload.fallbacks, 50),
    thinking: readRedactedString(payload.thinking),
    timeoutSeconds: readNonnegativeInteger(payload.timeoutSeconds),
    allowUnsafeExternalContent: payload.allowUnsafeExternalContent === true,
    lightContext: payload.lightContext === true,
    toolsAllow: readStringArray(payload.toolsAllow, 200),
  };
}

function sanitizeDelivery(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const delivery = asRecord(value);
  return {
    mode: readString(delivery.mode) ?? "unknown",
    channel: readRedactedString(delivery.channel),
    accountId: readRedactedString(delivery.accountId),
    bestEffort: delivery.bestEffort === true,
    targetFingerprint:
      delivery.to === undefined && delivery.threadId === undefined
        ? null
        : sha256Fingerprint({ to: delivery.to, threadId: delivery.threadId }),
  };
}

function sanitizeFailureAlert(value: unknown) {
  if (value === false) return false as const;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const alert = asRecord(value);
  return {
    after: readNonnegativeInteger(alert.after),
    cooldownMs: readNonnegativeInteger(alert.cooldownMs),
    mode: readRedactedString(alert.mode),
    channel: readRedactedString(alert.channel),
    accountId: readRedactedString(alert.accountId),
    targetFingerprint:
      alert.to === undefined ? null : sha256Fingerprint({ to: alert.to }),
  };
}

function sanitizeRuntime(value: unknown) {
  const state = asRecord(value);
  return {
    nextRunAtMs: readNonnegativeInteger(state.nextRunAtMs),
    runningAtMs: readNonnegativeInteger(state.runningAtMs),
    lastRunAtMs: readNonnegativeInteger(state.lastRunAtMs),
    lastRunStatus: readRedactedString(state.lastRunStatus),
    lastStatus: readRedactedString(state.lastStatus),
    lastError: safeDiagnosticFingerprint(state.lastError),
    lastErrorReason: safeDiagnosticFingerprint(state.lastErrorReason),
    lastDurationMs: readNonnegativeInteger(state.lastDurationMs),
    consecutiveErrors: readNonnegativeInteger(state.consecutiveErrors),
    lastFailureAlertAtMs: readNonnegativeInteger(state.lastFailureAlertAtMs),
    scheduleErrorCount: readNonnegativeInteger(state.scheduleErrorCount),
    lastDeliveryStatus: readRedactedString(state.lastDeliveryStatus),
    lastDeliveryError: safeDiagnosticFingerprint(state.lastDeliveryError),
    lastDelivered: typeof state.lastDelivered === "boolean" ? state.lastDelivered : null,
  };
}

async function collectSystemEntries(
  observedAt: Date,
  overrides?: {
    etcCrontab?: string;
    cronD?: string;
    spool?: string[];
  },
): Promise<{
  success: boolean;
  entries: CronInventoryEntry[];
  errors: CronInventoryCollectionError[];
}> {
  const files = new Map<string, { format: "system" | "user"; owner: string }>();
  const errors: CronInventoryCollectionError[] = [];
  let readableSourceCount = 0;
  const etcCrontab = overrides?.etcCrontab ?? "/etc/crontab";
  const cronD = overrides?.cronD ?? "/etc/cron.d";
  const spool = overrides?.spool ?? ["/var/spool/cron/crontabs", "/var/spool/cron"];

  const addFile = async (
    filePath: string,
    format: "system" | "user",
    owner: string,
  ) => {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return;
      files.set(path.resolve(filePath), { format, owner });
      readableSourceCount += 1;
    } catch (error) {
      if (!isMissing(error)) errors.push(systemReadError(filePath, error));
    }
  };
  const addDirectory = async (
    directory: string,
    format: "system" | "user",
  ) => {
    try {
      const names = await fs.readdir(directory);
      readableSourceCount += 1;
      for (const name of names) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
        await addFile(path.join(directory, name), format, format === "system" ? "root" : name);
      }
    } catch (error) {
      if (!isMissing(error)) errors.push(systemReadError(directory, error));
    }
  };

  await addFile(etcCrontab, "system", "root");
  await addDirectory(cronD, "system");
  for (const directory of spool) await addDirectory(directory, "user");

  const entries: CronInventoryEntry[] = [];
  const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  for (const [filePath, metadata] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      entries.push(
        ...parseSystemCronFile({
          filePath,
          content,
          format: metadata.format,
          owner: metadata.owner,
          defaultTimezone,
          observedAt,
        }),
      );
    } catch (error) {
      errors.push(systemReadError(filePath, error));
    }
  }
  if (readableSourceCount === 0 && errors.length === 0) {
    errors.push({
      source: "SYSTEM",
      code: "sourceUnavailable",
      message: "No supported system cron source exists",
    });
  }
  return {
    success: readableSourceCount > 0 && errors.length === 0,
    entries,
    errors,
  };
}

export function parseSystemCronFile(input: {
  filePath: string;
  content: string;
  format: "system" | "user";
  owner: string;
  defaultTimezone: string;
  observedAt: Date;
}): CronInventoryEntry[] {
  let timezone = input.defaultTimezone;
  const entries: CronInventoryEntry[] = [];
  for (const [index, rawLine] of input.content.split(/\r?\n/).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const enabled = !trimmed.startsWith("#");
    const candidate = enabled ? trimmed : trimmed.replace(/^#+\s*/, "");
    if (!candidate) continue;
    const envMatch = candidate.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (envMatch) {
      if (enabled && (envMatch[1] === "CRON_TZ" || envMatch[1] === "TZ")) {
        timezone = cleanEnvValue(envMatch[2] ?? "") || input.defaultTimezone;
      }
      continue;
    }
    const tokens = candidate.split(/\s+/);
    const macro = tokens[0]?.startsWith("@") ? tokens[0] : null;
    const scheduleFieldCount = macro ? 1 : 5;
    const userIndex = scheduleFieldCount;
    const commandIndex = input.format === "system" ? userIndex + 1 : userIndex;
    if (tokens.length <= commandIndex) {
      if (enabled) {
        entries.push(buildInvalidSystemCronEntry({
          filePath: input.filePath,
          sourceLine: index + 1,
          rawLine,
          timezone,
        }));
      }
      continue;
    }
    const expression = macro ?? tokens.slice(0, 5).join(" ");
    if (!enabled && !looksLikeSchedule(expression)) continue;
    const user = input.format === "system" ? tokens[userIndex] ?? null : input.owner;
    const sourceLine = index + 1;
    const fingerprint = sha256Fingerprint({ filePath: input.filePath, rawLine });
    let parseStatus: CronInventoryEntry["parseStatus"] = "SUPPORTED";
    let parseError: string | null = null;
    let nextRunAtMs: number | null = null;
    try {
      const normalized = SYSTEM_CRON_MACROS[expression] ?? expression;
      if (expression.startsWith("@") && !SYSTEM_CRON_MACROS[expression]) {
        throw new UnsupportedSystemCronError(`Unsupported system cron macro: ${expression}`);
      }
      nextRunAtMs = CronExpressionParser.parse(normalized, {
        currentDate: input.observedAt,
        tz: timezone,
      })
        .next()
        .getTime();
    } catch (error) {
      parseStatus = error instanceof UnsupportedSystemCronError ? "UNSUPPORTED" : "INVALID";
      parseError = normalizeError(error);
    }
    entries.push({
      source: "SYSTEM",
      sourceId: `system:${sha256Fingerprint({ filePath: input.filePath, line: sourceLine }).slice(7)}`,
      name: `${user ?? "unknown"}@${path.basename(input.filePath)}:${sourceLine}`,
      description: null,
      enabled,
      schedule: { kind: "system", expression },
      timezone,
      nextRunAtMs,
      parseStatus,
      parseError,
      configFingerprint: fingerprint,
      system: {
        sourcePath: input.filePath,
        line: sourceLine,
        user,
        fingerprint,
      },
    });
  }
  return entries;
}

function buildInvalidSystemCronEntry(input: {
  filePath: string;
  sourceLine: number;
  rawLine: string;
  timezone: string;
}): CronInventoryEntry {
  const fingerprint = sha256Fingerprint({ filePath: input.filePath, rawLine: input.rawLine });
  return {
    source: "SYSTEM",
    sourceId: `system:${sha256Fingerprint({ filePath: input.filePath, line: input.sourceLine }).slice(7)}`,
    name: `unknown@${path.basename(input.filePath)}:${input.sourceLine}`,
    description: null,
    enabled: true,
    schedule: { kind: "system", expression: "<invalid>" },
    timezone: input.timezone,
    nextRunAtMs: null,
    parseStatus: "INVALID",
    parseError: "Malformed system cron entry",
    configFingerprint: fingerprint,
    system: {
      sourcePath: input.filePath,
      line: input.sourceLine,
      user: null,
      fingerprint,
    },
  };
}

function validateSchedule(
  schedule: CronInventoryEntry["schedule"],
  observedAt: Date,
): void {
  if (schedule.kind === "unsupported") throw new Error("Unsupported OpenClaw schedule");
  if (schedule.kind === "at") {
    if (!Number.isFinite(Date.parse(schedule.at))) throw new Error("Invalid at schedule");
    return;
  }
  if (schedule.kind === "every") return;
  const expression =
    schedule.kind === "system"
      ? SYSTEM_CRON_MACROS[schedule.expression] ?? schedule.expression
      : schedule.expr;
  CronExpressionParser.parse(expression, {
    currentDate: observedAt,
    ...(schedule.kind === "cron" && schedule.tz ? { tz: schedule.tz } : {}),
  });
}

function looksLikeSchedule(expression: string): boolean {
  if (expression.startsWith("@")) return true;
  return expression.split(/\s+/).length === 5;
}

function cleanEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function systemReadError(
  sourceId: string,
  error: unknown,
): CronInventoryCollectionError {
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    source: "SYSTEM",
    code: code === "EACCES" || code === "EPERM" ? "permissionDenied" : "sourceUnavailable",
    sourceId,
    message: `${code ?? "READ_FAILED"}: ${sourceId}`,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, max = 1_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function readRedactedString(value: unknown, max = 1_000): string | null {
  const text = readString(value, max);
  return text ? redactSecrets(text) : null;
}

function readStringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .slice(0, max)
        .map((entry) => entry.slice(0, 500))
    : [];
}

function safeDiagnosticFingerprint(value: unknown): string | null {
  const text = readString(value, 10_000);
  return text ? `[redacted:${sha256Fingerprint(text)}]` : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeError(error: unknown): string {
  return redactSecrets(
    (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  );
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*bearer|bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b(token|api[_-]?key|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    );
}

class UnsupportedSystemCronError extends Error {}
