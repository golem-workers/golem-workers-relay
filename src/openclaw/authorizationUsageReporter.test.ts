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
        getSessionsUsage: vi.fn().mockResolvedValue({ aggregates: {} }),
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
        .mockResolvedValueOnce({
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

      expect(getSessionsUsage).toHaveBeenCalledTimes(2);
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
