import { describe, expect, it, vi } from "vitest";
import { __testing, createAuthorizationUsageReporter } from "./authorizationUsageReporter.js";

describe("authorization usage reporter", () => {
  it("keeps OpenAI account limits global and filters agent usage to OpenAI models", () => {
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
          byProvider: [{ provider: "openai", input: 100, output: 20, cacheRead: 30, totalTokens: 150 }],
          byModel: [
            { provider: "openai", model: "gpt-5.6-sol", tokens: 150, count: 3 },
            { provider: "anthropic", model: "claude", tokens: 999, count: 5 },
          ],
          modelDaily: [
            { date: "2026-07-31", provider: "openai", model: "gpt-5.6-sol", tokens: 150 },
            { date: "2026-07-31", provider: "anthropic", model: "claude", tokens: 999 },
          ],
        },
        cache: { status: "fresh" },
      },
    });

    expect(payload.providerUsage).toMatchObject({ provider: "openai", plan: "pro" });
    expect(payload.providerUsage.windows).toEqual([{ label: "168h", usedPercent: 76 }]);
    expect(payload.totals).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      totalTokens: 150,
      requestCount: 3,
    });
    expect(payload.byModel).toHaveLength(1);
    expect(payload.daily).toHaveLength(1);
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
