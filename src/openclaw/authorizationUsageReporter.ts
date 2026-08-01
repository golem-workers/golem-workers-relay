import type { RelayAuthorizationUsageRequest } from "../backend/types.js";
import { logger } from "../logger.js";

type GatewayUsageReader = {
  getUsageStatus(): Promise<unknown>;
  getSessionsUsage(
    params: { startDate: string; endDate: string; limit?: number },
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

function readNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (key in source) return finiteNonnegative(source[key]);
  }
  return 0;
}

function readTotals(source: Record<string, unknown> | null, requestCount: number) {
  const record = source ?? {};
  return {
    inputTokens: readNumber(record, ["inputTokens", "input"]),
    outputTokens: readNumber(record, ["outputTokens", "output"]),
    cacheReadTokens: readNumber(record, ["cacheReadTokens", "cacheRead"]),
    cacheWriteTokens: readNumber(record, ["cacheWriteTokens", "cacheWrite"]),
    totalTokens: readNumber(record, ["totalTokens", "tokens"]),
    requestCount,
  };
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
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
  const openAiTotals =
    byProvider.find((item) => normalizedProvider(item.provider) === "openai") ?? null;
  const byModel = asRecords(aggregates.byModel).filter(
    (item) => normalizedProvider(item.provider) === "openai",
  );
  const modelDaily = asRecords(aggregates.modelDaily).filter(
    (item) => normalizedProvider(item.provider) === "openai",
  );
  const requestCount = byModel.reduce((sum, item) => sum + readNumber(item, ["count", "requests"]), 0);
  const cacheStatus = isRecord(usage.cache) ? usage.cache : isRecord(usage.cacheStatus) ? usage.cacheStatus : null;
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
    totals: readTotals(openAiTotals, requestCount),
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
        input.gateway.getSessionsUsage(
          { startDate: dateOnly(periodStart), endDate: dateOnly(periodEnd), limit: 1_000 },
          { timeoutMs: 30_000 },
        ),
      ]);
      const result = await input.backend.submitAuthorizationUsage({
        body: buildPayload({ status, usage, observedAt, periodStart, periodEnd }),
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

export const __testing = { buildPayload };
