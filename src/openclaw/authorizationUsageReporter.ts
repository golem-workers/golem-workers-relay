import type { GatewaySessionsUsageParams } from "./gatewayClient.js";
import type { RelayAuthorizationUsageRequest } from "../backend/types.js";
import { logger } from "../logger.js";

type GatewayUsageReader = {
  getUsageStatus(): Promise<unknown>;
  getSessionsUsage(
    params: GatewaySessionsUsageParams,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
};

type UsageBackend = {
  submitAuthorizationUsage(input: {
    body: RelayAuthorizationUsageRequest;
  }): Promise<{ accepted: true; assigned: boolean; authorizationAccountId?: string }>;
};

type ReporterState = {
  enabled: boolean;
  running: boolean;
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastAssigned: boolean | null;
  lastError: string | null;
};

type UsageTotals = RelayAuthorizationUsageRequest["totals"];

const OPENAI_USAGE_PROVIDERS = new Set(["openai", "openai-codex", "codex", "codex-cli"]);
const USAGE_CACHE_SETTLE_TIMEOUT_MS = 30_000;
const USAGE_CACHE_SETTLE_INITIAL_POLL_MS = 250;
const USAGE_CACHE_SETTLE_MAX_POLL_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizedProvider(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isOpenAiUsageProvider(value: unknown): boolean {
  return OPENAI_USAGE_PROVIDERS.has(normalizedProvider(value));
}

function readNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (key in source) return finiteNonnegative(source[key]);
  }
  return 0;
}

function readTotals(source: Record<string, unknown> | null): Omit<UsageTotals, "requestCount"> {
  const record = source && isRecord(source.totals) ? source.totals : (source ?? {});
  return {
    inputTokens: readNumber(record, ["inputTokens", "input"]),
    outputTokens: readNumber(record, ["outputTokens", "output"]),
    cacheReadTokens: readNumber(record, ["cacheReadTokens", "cacheRead"]),
    cacheWriteTokens: readNumber(record, ["cacheWriteTokens", "cacheWrite"]),
    totalTokens: readNumber(record, ["totalTokens", "tokens"]),
  };
}

function sumTotals(records: Array<Record<string, unknown>>): Omit<UsageTotals, "requestCount"> {
  return records.reduce<Omit<UsageTotals, "requestCount">>(
    (total, record) => {
      const current = readTotals(record);
      total.inputTokens += current.inputTokens;
      total.outputTokens += current.outputTokens;
      total.cacheReadTokens += current.cacheReadTokens;
      total.cacheWriteTokens += current.cacheWriteTokens;
      total.totalTokens += current.totalTokens;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
  );
}

function canonicalizeOpenAiUsageRecord(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, provider: "openai" };
}

function readCacheStatus(usage: unknown): Record<string, unknown> | null {
  if (!isRecord(usage)) return null;
  return isRecord(usage.cacheStatus)
    ? usage.cacheStatus
    : isRecord(usage.cache)
      ? usage.cache
      : null;
}

function isUsageCacheSettled(usage: unknown): boolean {
  const cacheStatus = readCacheStatus(usage);
  return !cacheStatus || cacheStatus.status === "fresh";
}

function usageCacheError(usage: unknown): Error {
  const cacheStatus = readCacheStatus(usage);
  const status = typeof cacheStatus?.status === "string" ? cacheStatus.status : "unknown";
  const cachedFiles = cacheStatus ? readNumber(cacheStatus, ["cachedFiles"]) : 0;
  const pendingFiles = cacheStatus ? readNumber(cacheStatus, ["pendingFiles"]) : 0;
  return new Error(
    `Authorization usage cache did not settle (${status}; ${cachedFiles} cached, ${pendingFiles} pending)`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettledSessionsUsage(input: {
  gateway: GatewayUsageReader;
  params: GatewaySessionsUsageParams;
}): Promise<unknown> {
  const deadline = Date.now() + USAGE_CACHE_SETTLE_TIMEOUT_MS;
  let pollMs = USAGE_CACHE_SETTLE_INITIAL_POLL_MS;
  let lastUsage: unknown;

  for (;;) {
    const remainingBeforeCallMs = deadline - Date.now();
    if (remainingBeforeCallMs <= 0) throw usageCacheError(lastUsage);
    lastUsage = await input.gateway.getSessionsUsage(input.params, {
      timeoutMs: Math.min(30_000, remainingBeforeCallMs),
    });
    if (isUsageCacheSettled(lastUsage)) return lastUsage;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw usageCacheError(lastUsage);
    await sleep(Math.min(pollMs, remainingMs));
    pollMs = Math.min(pollMs * 2, USAGE_CACHE_SETTLE_MAX_POLL_MS);
  }
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Gateway accepts calendar dates, but filters individual usage events by the resulting
// millisecond bounds. A fixed offset makes its midnight the current UTC minute.
// Thus one complete date is exactly [windowEnd - 24h, windowEnd), without DST
// or prorating daily totals. The snapshot explicitly exposes the minute-aligned end.
function rolling24hQuery(now: Date) {
  const endMs = Math.floor(now.getTime() / 60_000) * 60_000;
  const minuteOfDay = new Date(endMs).getUTCHours() * 60 + new Date(endMs).getUTCMinutes();
  const offset = minuteOfDay <= 720 ? -minuteOfDay : 1440 - minuteOfDay;
  const absolute = Math.abs(offset);
  const utcOffset = `UTC${offset < 0 ? "-" : "+"}${Math.floor(absolute / 60)}:${String(absolute % 60).padStart(2, "0")}`;
  const startDate = dateOnly(new Date(endMs - 86_400_000 + offset * 60_000));
  return {
    windowStart: new Date(endMs - 86_400_000).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    params: { startDate, endDate: startDate, mode: "specific", utcOffset, limit: 1 } satisfies GatewaySessionsUsageParams,
  };
}

function buildPayload(input: {
  status: unknown;
  usage: unknown;
  observedAt: Date;
  periodStart: Date;
  periodEnd: Date;
}): RelayAuthorizationUsageRequest {
  const status = isRecord(input.status) ? input.status : {};
  const providers = asRecords(status.providers);
  const openAiStatus =
    providers.find((item) => normalizedProvider(item.provider) === "openai") ?? {
      provider: "openai",
      displayName: "OpenAI",
      windows: [],
      billing: [],
      error: "OpenAI usage status is unavailable.",
    };
  const usage = isRecord(input.usage) ? input.usage : {};
  const aggregates = isRecord(usage.aggregates) ? usage.aggregates : {};
  const byProvider = asRecords(aggregates.byProvider);
  const openAiProviderUsage = byProvider.filter((item) => isOpenAiUsageProvider(item.provider));
  const byModel = asRecords(aggregates.byModel)
    .filter((item) => isOpenAiUsageProvider(item.provider))
    .map(canonicalizeOpenAiUsageRecord);
  const modelDaily = asRecords(aggregates.modelDaily)
    .filter((item) => isOpenAiUsageProvider(item.provider))
    .map(canonicalizeOpenAiUsageRecord);
  const modelRequestCount = byModel.reduce(
    (sum, item) => sum + readNumber(item, ["count", "requests"]),
    0,
  );
  const providerRequestCount = openAiProviderUsage.reduce(
    (sum, item) => sum + readNumber(item, ["count", "requests"]),
    0,
  );
  const cacheStatus = readCacheStatus(usage);
  return {
    observedAtMs: input.observedAt.getTime(),
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    providerUsage: {
      provider: "openai",
      displayName:
        typeof openAiStatus.displayName === "string" ? openAiStatus.displayName : "OpenAI",
      plan: typeof openAiStatus.plan === "string" ? openAiStatus.plan : null,
      windows: asRecords(openAiStatus.windows),
      billing: asRecords(openAiStatus.billing),
      error: typeof openAiStatus.error === "string" ? openAiStatus.error : null,
    },
    totals: {
      ...sumTotals(openAiProviderUsage),
      requestCount: modelRequestCount || providerRequestCount,
    },
    byModel,
    daily: modelDaily,
    cacheStatus,
  };
}

export function createAuthorizationUsageReporter(input: {
  enabled: boolean;
  intervalMs: number;
  lookbackDays: number;
  gateway: GatewayUsageReader;
  backend: UsageBackend;
}) {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const state: ReporterState = {
    enabled: input.enabled,
    running: false,
    lastAttemptAtMs: null,
    lastSuccessAtMs: null,
    lastAssigned: null,
    lastError: null,
  };

  const run = async (): Promise<void> => {
    if (!input.enabled || stopped || state.running) return;
    state.running = true;
    state.lastAttemptAtMs = Date.now();
    try {
      const observedAt = new Date();
      const periodEnd = observedAt;
      const periodStart = new Date(observedAt.getTime() - input.lookbackDays * 86_400_000);
      const [status, usage] = await Promise.all([
        input.gateway.getUsageStatus(),
        getSettledSessionsUsage({
          gateway: input.gateway,
          params: { startDate: dateOnly(periodStart), endDate: dateOnly(periodEnd), limit: 1_000 },
        }),
      ]);
      const window = rolling24hQuery(observedAt);
      const rollingUsage = await getSettledSessionsUsage({ gateway: input.gateway, params: window.params });
      if (!isRecord(rollingUsage) || !isRecord(rollingUsage.aggregates) ||
          !Array.isArray(rollingUsage.aggregates.byProvider)) {
        throw new Error("Rolling token usage provider aggregates are unavailable");
      }
      const rollingPayload = buildPayload({ status, usage: rollingUsage, observedAt,
        periodStart: new Date(window.windowStart), periodEnd: new Date(window.windowEnd) });
      const result = await input.backend.submitAuthorizationUsage({
        body: { ...buildPayload({ status, usage, observedAt, periodStart, periodEnd }),
          rolling24h: { windowStart: window.windowStart, windowEnd: window.windowEnd,
            totalTokens: rollingPayload.totals.totalTokens } },
      });
      state.lastSuccessAtMs = Date.now();
      state.lastAssigned = result.assigned;
      state.lastError = null;
      logger.debug(
        { assigned: result.assigned, authorizationAccountId: result.authorizationAccountId ?? null },
        "Authorization usage report submitted",
      );
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      logger.warn({ error: state.lastError }, "Authorization usage report failed");
    } finally {
      state.running = false;
    }
  };

  return {
    start(): void {
      if (!input.enabled || timer) return;
      stopped = false;
      void run();
      timer = setInterval(() => void run(), input.intervalMs);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    run,
    getState(): ReporterState {
      return { ...state };
    },
  };
}

export const __testing = { buildPayload, isUsageCacheSettled, rolling24hQuery };
