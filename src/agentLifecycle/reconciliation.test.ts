import { describe, expect, it } from "vitest";

import {
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
