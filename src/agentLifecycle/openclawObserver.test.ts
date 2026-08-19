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

  it("extracts subscribed session lifecycle start and terminal events", () => {
    const start = observeOpenClawLifecycleFrame({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:telegram:group:1",
        sessionId: "session-1",
        agentId: "main",
        phase: "start",
        runId: "run-1",
        ts: Date.parse("2026-08-19T10:00:00.000Z"),
        status: "running",
      },
    });
    const terminal = observeOpenClawLifecycleFrame({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:telegram:group:1",
        agentId: "main",
        phase: "end",
        runId: "run-1",
        ts: Date.parse("2026-08-19T10:00:05.000Z"),
        status: "done",
        session: { sessionId: "session-1", status: "done" },
      },
    });

    expect(start).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "main",
      occurredAt: "2026-08-19T10:00:00.000Z",
      signal: {
        event: "lifecycle",
        phase: "start",
        persistedStatus: "running",
      },
    });
    expect(terminal).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      agentId: "main",
      occurredAt: "2026-08-19T10:00:05.000Z",
      signal: {
        event: "lifecycle",
        phase: "end",
        persistedStatus: "done",
      },
    });
  });

  it("maps a yielded subscribed session event to the native waiting signal", () => {
    const result = observeOpenClawLifecycleFrame({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:main",
        phase: "end",
        runId: "run-waiting",
        status: "running",
      },
    });

    expect(result?.signal).toEqual({
      event: "lifecycle",
      phase: "end",
      yielded: true,
      paused: true,
      persistedStatus: "running",
    });
  });

  it("ignores non-lifecycle session changes", () => {
    const result = observeOpenClawLifecycleFrame({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:main",
        phase: "message",
        runId: "run-1",
      },
    });

    expect(result).toBeNull();
  });
});
