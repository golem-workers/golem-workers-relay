import type { GatewaySessionsUsageParams } from "./gatewayClient.js";
import { describe, expect, it, vi } from "vitest";
import type { RelayAuthorizationUsageRequest } from "../backend/types.js";
import { __testing, createAuthorizationUsageReporter } from "./authorizationUsageReporter.js";

describe("authorization usage reporter", () => {
  it("reads current nested OpenClaw totals and combines OpenAI provider aliases", () => {
    const payload = __testing.buildPayload({
      observedAt: new Date("2026-07-31T10:00:00.000Z"),
      periodStart: new Date("2026-07-01T10:00:00.000Z"),
      periodEnd: new Date("2026-07-31T10:00:00.000Z"),
      status: {
        providers: [
          { provider: "openai", displayName: "OpenAI", plan: "pro", windows: [{ label: "168h", usedPercent: 76 }], billing: [] },
          { provider: "other", windows: [{ usedPercent: 99 }] },
        ],
      },
      usage: {
        aggregates: {
          byProvider: [
            {
              provider: "openai",
              count: 3,
              totals: {
                input: 100,
                output: 20,
                cacheRead: 30,
                cacheWrite: 0,
                totalTokens: 150,
              },
            },
            {
              provider: "codex",
              count: 2,
              totals: {
                input: 40,
                output: 10,
                cacheRead: 10,
                cacheWrite: 0,
                totalTokens: 60,
              },
            },
            {
              provider: "anthropic",
              count: 5,
              totals: { input: 900, output: 99, totalTokens: 999 },
            },
          ],
          byModel: [
            {
              provider: "openai",
              model: "gpt-5.6-sol",
              count: 3,
              totals: { input: 100, output: 20, cacheRead: 30, totalTokens: 150 },
            },
            {
              provider: "codex",
              model: "gpt-5.6-sol",
              count: 2,
              totals: { input: 40, output: 10, cacheRead: 10, totalTokens: 60 },
            },
            {
              provider: "anthropic",
              model: "claude",
              count: 5,
              totals: { input: 900, output: 99, totalTokens: 999 },
            },
          ],
          modelDaily: [
            {
              date: "2026-07-31",
              provider: "openai",
              model: "gpt-5.6-sol",
              tokens: 150,
              count: 3,
            },
            {
              date: "2026-07-31",
              provider: "codex",
              model: "gpt-5.6-sol",
              tokens: 60,
              count: 2,
            },
            { date: "2026-07-31", provider: "anthropic", model: "claude", tokens: 999 },
          ],
        },
        cacheStatus: { status: "fresh", cachedFiles: 2, pendingFiles: 0, staleFiles: 0 },
      },
    });

    expect(payload.providerUsage).toMatchObject({ provider: "openai", plan: "pro" });
    expect(payload.providerUsage.windows).toEqual([{ label: "168h", usedPercent: 76 }]);
    expect(payload.totals).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      totalTokens: 210,
      requestCount: 5,
    });
    expect(payload.byModel).toHaveLength(2);
    expect(payload.byModel.every((item) => item.provider === "openai")).toBe(true);
    expect(payload.daily).toHaveLength(2);
    expect(payload.daily.every((item) => item.provider === "openai")).toBe(true);
  });

  it("keeps compatibility with legacy flat aggregate totals", () => {
    const payload = __testing.buildPayload({
      observedAt: new Date("2026-07-31T10:00:00.000Z"),
      periodStart: new Date("2026-07-01T10:00:00.000Z"),
      periodEnd: new Date("2026-07-31T10:00:00.000Z"),
      status: { providers: [{ provider: "openai", windows: [] }] },
      usage: {
        aggregates: {
          byProvider: [
            { provider: "openai-codex", input: 100, output: 20, cacheRead: 30, totalTokens: 150 },
          ],
          byModel: [{ provider: "openai-codex", model: "gpt-5.5", count: 3 }],
        },
        cache: { status: "fresh" },
      },
    });

    expect(payload.totals).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      totalTokens: 150,
      requestCount: 3,
    });
  });

  it("submits once immediately and records whether the agent is assigned", async () => {
    const submitAuthorizationUsage = vi.fn().mockResolvedValue({ accepted: true, assigned: true, authorizationAccountId: "auth_1" });
    const reporter = createAuthorizationUsageReporter({
      enabled: true,
      intervalMs: 300_000,
      lookbackDays: 30,
      gateway: {
        getUsageStatus: vi.fn().mockResolvedValue({ providers: [] }),
        getSessionsUsage: vi.fn().mockResolvedValue({ aggregates: { byProvider: [] } }),
      },
      backend: { submitAuthorizationUsage },
    });
    await reporter.run();
    expect(submitAuthorizationUsage).toHaveBeenCalledTimes(1);
    expect(reporter.getState()).toMatchObject({ lastAssigned: true, lastError: null });
  });

  it("waits for a fresh usage cache before submitting telemetry", async () => {
    vi.useFakeTimers();
    try {
      const submitAuthorizationUsage = vi
        .fn<
          (input: { body: RelayAuthorizationUsageRequest }) => Promise<{
            accepted: true;
            assigned: boolean;
            authorizationAccountId?: string;
          }>
        >()
        .mockResolvedValue({ accepted: true, assigned: true, authorizationAccountId: "auth_1" });
      const getSessionsUsage = vi
        .fn()
        .mockResolvedValueOnce({
          aggregates: {},
          cacheStatus: { status: "refreshing", cachedFiles: 2, pendingFiles: 1, staleFiles: 1 },
        })
        .mockResolvedValue({
          aggregates: {
            byProvider: [
              {
                provider: "openai",
                count: 1,
                totals: { input: 80, output: 20, cacheRead: 0, totalTokens: 100 },
              },
            ],
            byModel: [{ provider: "openai", model: "gpt-5.6-sol", count: 1 }],
          },
          cacheStatus: { status: "fresh", cachedFiles: 3, pendingFiles: 0, staleFiles: 0 },
        });
      const reporter = createAuthorizationUsageReporter({
        enabled: true,
        intervalMs: 300_000,
        lookbackDays: 30,
        gateway: {
          getUsageStatus: vi.fn().mockResolvedValue({ providers: [] }),
          getSessionsUsage,
        },
        backend: { submitAuthorizationUsage },
      });

      const run = reporter.run();
      await vi.advanceTimersByTimeAsync(250);
      await run;

      expect(getSessionsUsage).toHaveBeenCalledTimes(3);
      expect(submitAuthorizationUsage).toHaveBeenCalledTimes(1);
      const submitted = submitAuthorizationUsage.mock.calls[0]?.[0];
      expect(submitted?.body.totals).toMatchObject({ totalTokens: 100, requestCount: 1 });
      expect(submitted?.body.cacheStatus).toMatchObject({ status: "fresh" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not attribute all-provider totals to OpenAI when OpenAI aggregates are unavailable", () => {
    const payload = __testing.buildPayload({
      observedAt: new Date("2026-07-31T10:00:00.000Z"),
      periodStart: new Date("2026-07-01T10:00:00.000Z"),
      periodEnd: new Date("2026-07-31T10:00:00.000Z"),
      status: { providers: [{ provider: "openai", windows: [] }] },
      usage: {
        totals: { input: 900, output: 100, totalTokens: 1_000 },
        aggregates: {
          byProvider: [{ provider: "anthropic", input: 900, output: 100, totalTokens: 1_000 }],
          byModel: [{ provider: "anthropic", model: "claude", tokens: 1_000, count: 4 }],
        },
      },
    });

    expect(payload.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      requestCount: 0,
    });
  });
});


describe("rolling 24-hour usage", () => {
  it("maps every UTC minute to exactly the preceding 24h across year boundaries", () => {
    for (let minute = 0; minute < 1440; minute++) {
      const now = new Date(Date.UTC(2027, 0, 1, 0, minute, 59));
      const query = __testing.rolling24hQuery(now);
      const match = /^UTC([+-])(\d+):(\d+)$/.exec(query.params.utcOffset)!;
      const offset = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
      expect(offset).toBeGreaterThanOrEqual(-720);
      expect(offset).toBeLessThanOrEqual(840);
      // Same inclusive day-boundary calculation used by the gateway.
      const start = Date.parse(query.params.startDate + 'T00:00:00Z') - offset * 60_000;
      expect(start).toBe(Date.parse(query.windowStart));
      expect(start + 86_400_000).toBe(Date.parse(query.windowEnd));
      expect(Date.parse(query.windowEnd)).toBe(Math.floor(now.getTime() / 60_000) * 60_000);
      expect(query.params.endDate).toBe(query.params.startDate);
    }
  });

  it("submits an independently measured OpenAI window instead of daily or cumulative totals", async () => {
    const submitAuthorizationUsage = vi.fn().mockResolvedValue({ accepted: true, assigned: true });
    const getSessionsUsage = vi.fn().mockImplementation((params: GatewaySessionsUsageParams) => Promise.resolve({
      aggregates: { byProvider: [
        { provider: 'openai', totals: { totalTokens: params.mode === 'specific' ? 42 : 9000 } },
        { provider: 'anthropic', totals: { totalTokens: 777 } },
      ] }, cacheStatus: { status: 'fresh' },
    }));
    const reporter = createAuthorizationUsageReporter({ enabled: true, intervalMs: 300000, lookbackDays: 30,
      gateway: { getUsageStatus: vi.fn().mockResolvedValue({}), getSessionsUsage }, backend: { submitAuthorizationUsage } });
    await reporter.run();
    expect((submitAuthorizationUsage.mock.calls[0][0] as { body: RelayAuthorizationUsageRequest }).body).toMatchObject({
      totals: { totalTokens: 9000 }, rolling24h: { totalTokens: 42 },
    });
    expect(getSessionsUsage.mock.calls[1][0]).toMatchObject({ mode: 'specific', limit: 1 });
  });

  it.each(['unsupported', 'malformed'])("does not publish fake zero for %s window responses", async (kind) => {
    const submitAuthorizationUsage = vi.fn();
    const reporter = createAuthorizationUsageReporter({ enabled: true, intervalMs: 300000, lookbackDays: 30,
      gateway: { getUsageStatus: vi.fn().mockResolvedValue({}), getSessionsUsage: vi.fn().mockImplementation((params: GatewaySessionsUsageParams) => {
        if (params.mode && kind === 'unsupported') return Promise.reject(new Error('Unsupported offset'));
        return Promise.resolve({ aggregates: {} });
      }) }, backend: { submitAuthorizationUsage } });
    await reporter.run();
    expect(submitAuthorizationUsage).not.toHaveBeenCalled();
    expect(reporter.getState().lastError).toBeTruthy();
  });
});
