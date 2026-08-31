import { describe, expect, it } from "vitest";

import {
  describeOpenClawActiveRunsPayload,
  planAgentLifecycleReconciliation,
  readOpenClawActiveRuns,
} from "./reconciliation.js";

describe("agent lifecycle exceptional reconciliation", () => {
  it("reads authoritative OpenClaw active run ids without inventing idle traffic", () => {
    expect(
      readOpenClawActiveRuns({
        sessions: [
          {
            key: "agent:main:one",
            sessionId: "session-1",
            agentId: "main",
            hasActiveRun: true,
            activeRunIds: ["run-1"],
          },
          { key: "agent:main:idle", hasActiveRun: false },
        ],
      }),
    ).toEqual([
      {
        provider: "openclaw",
        agentId: "main",
        sessionId: "session-1",
        runId: "run-1",
        status: "RUNNING",
      },
    ]);
    expect(readOpenClawActiveRuns({ sessions: [] })).toEqual([]);
  });

  it("describes the exact session fields used by hibernation safety", () => {
    expect(
      describeOpenClawActiveRunsPayload({
        sessions: [
          {
            key: "agent:main:telegram:group:1",
            sessionId: "session-1",
            agentId: "main",
            hasActiveRun: false,
            activeRunIds: [],
            status: "idle",
            updatedAt: "2026-08-31T10:29:47.000Z",
            lastActivityAt: "2026-08-31T10:29:47.000Z",
            sourceGeneration: "generation-7",
          },
        ],
      }),
    ).toEqual({
      payloadValid: true,
      sessionCount: 1,
      activeSessionCount: 0,
      activeRunIdCount: 0,
      sessions: [
        {
          key: "agent:main:telegram:group:1",
          sessionId: "session-1",
          agentId: "main",
          hasActiveRun: false,
          activeRunIds: [],
          status: "idle",
          updatedAt: "2026-08-31T10:29:47.000Z",
          lastActivityAt: "2026-08-31T10:29:47.000Z",
          sourceGeneration: "generation-7",
        },
      ],
    });
    expect(describeOpenClawActiveRunsPayload({ invalid: true })).toEqual({
      payloadValid: false,
      sessionCount: 0,
      activeSessionCount: 0,
      activeRunIdCount: 0,
      sessions: [],
    });
  });

  it("plans rebinds, newly observed runs, and disappeared runs deterministically", () => {
    const corrections = planAgentLifecycleReconciliation({
      checkpoint: [
        {
          provider: "openclaw",
          sessionId: "session-waiting",
          runId: "run-waiting",
          status: "WAITING",
        },
        {
          provider: "openclaw",
          sessionId: "session-gone",
          runId: "run-gone",
          status: "RUNNING",
        },
      ],
      observed: [
        {
          provider: "openclaw",
          sessionId: "session-waiting",
          runId: "run-waiting",
          status: "RUNNING",
        },
        {
          provider: "openclaw",
          sessionId: "session-new",
          runId: "run-new",
          status: "RUNNING",
        },
      ],
    });

    expect(corrections).toEqual([
      {
        kind: "ACTIVE",
        run: {
          provider: "openclaw",
          sessionId: "session-waiting",
          runId: "run-waiting",
          status: "WAITING",
        },
      },
      {
        kind: "ACTIVE",
        run: {
          provider: "openclaw",
          sessionId: "session-new",
          runId: "run-new",
          status: "RUNNING",
        },
      },
      {
        kind: "DISAPPEARED",
        run: {
          provider: "openclaw",
          sessionId: "session-gone",
          runId: "run-gone",
          status: "RUNNING",
        },
      },
    ]);
  });
});
