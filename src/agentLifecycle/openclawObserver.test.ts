import { describe, expect, it } from "vitest";

import { observeOpenClawLifecycleFrame } from "./openclawObserver.js";

describe("OpenClaw lifecycle frame observer", () => {
  it("extracts lifecycle context and native terminal data", () => {
    const result = observeOpenClawLifecycleFrame({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionKey: "agent:main:telegram:group:1",
        sessionId: "session-1",
        agentId: "main",
        stream: "lifecycle",
        ts: Date.parse("2026-08-19T10:00:00.000Z"),
        data: { phase: "end", status: "failed" },
      },
    });

    expect(result).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "main",
      occurredAt: "2026-08-19T10:00:00.000Z",
      signal: {
        event: "lifecycle",
        phase: "end",
        persistedStatus: "failed",
      },
    });
  });

  it("extracts approval transitions and ignores non-lifecycle streams", () => {
    const approval = observeOpenClawLifecycleFrame({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionId: "session-1",
        stream: "approval",
        data: { phase: "requested", status: "pending" },
      },
    });
    const chatter = observeOpenClawLifecycleFrame({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionId: "session-1",
        stream: "assistant",
        data: { delta: "hello" },
      },
    });

    expect(approval?.signal).toEqual({
      event: "approval",
      phase: "requested",
      status: "pending",
    });
    expect(chatter).toBeNull();
  });
});
