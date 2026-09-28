import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLifecycleEvent } from "./contract.js";
import { createAgentLifecycleRelay } from "./relay.js";

const run = {
  provider: "openclaw",
  agentId: "main",
  sessionId: "session-1",
  runId: "run-1",
  status: "WAITING" as const,
};
function fixture(query = vi.fn<() => Promise<unknown>>()) {
  const events: AgentLifecycleEvent[] = [];
  const registerGeneration = vi.fn(
    ({ sourceGeneration }: { sourceGeneration: string }) =>
      Promise.resolve({
        accepted: true as const,
        disposition: "ACTIVATED" as const,
        serverId: "server-1",
        sourceGeneration,
        generationOrdinal: 1,
        activeRuns: [run],
      }),
  );
  const drain = vi.fn(() =>
    Promise.resolve({ acknowledged: 0, pending: 0, blocked: false }),
  );
  const relay = createAgentLifecycleRelay({
    backend: { registerGeneration, submitEvent: vi.fn() },
    sourceStore: {
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
    },
    outbox: {
      enqueue: (event) => {
        events.push(event);
        return Promise.resolve({
          fileName: event.eventId,
          enqueuedAt: event.occurredAt,
          event,
        });
      },
      list: () => Promise.resolve([]),
      acknowledge: () => Promise.resolve(),
      quarantine: () => Promise.resolve(),
    },
    publisher: { publish: vi.fn(), drain },
    queryActiveRuns: () => Promise.resolve([]),
    querySessionStates: query,
    waitingPollIntervalMs: 1000,
  });
  relay.handleGatewayConnectionStateChange({ connected: true });
  return { relay, query, events, registerGeneration, drain };
}
function payload(status: string, extra = {}) {
  return {
    sessions: [
      {
        key: "agent:main:test",
        sessionId: run.sessionId,
        agentId: "main",
        status,
        hasActiveRun: false,
        activeRunIds: [],
        ...extra,
      },
    ],
  };
}

describe("local WAITING reconciliation", () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    ["done", "COMPLETED"],
    ["failed", "FAILED"],
    ["timeout", "FAILED"],
    ["killed", "CANCELLED"],
  ])(
    "publishes verified %s once without registering a generation on each poll",
    async (status, expected) => {
      vi.useFakeTimers();
      const f = fixture();
      f.query.mockResolvedValue(payload(status));
      await f.relay.flush();
      expect(f.events).toEqual([]); // missing from active runs does not cancel WAITING
      await vi.advanceTimersByTimeAsync(1000);
      await f.relay.flush();
      expect(f.events.map((e) => e.status)).toEqual([expected]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.query).toHaveBeenCalledTimes(1);
      expect(f.registerGeneration).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    payload("running"),
    {},
    { sessions: [] },
    payload("done", { hasActiveRun: true }),
    payload("done", { activeRunIds: ["new-run"] }),
    payload("done", { sessionId: "other" }),
  ])("keeps uncertain or genuine waiting local", async (response) => {
    vi.useFakeTimers();
    const f = fixture();
    f.query.mockResolvedValue(response);
    await f.relay.flush();
    const baseline = f.drain.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.events).toEqual([]);
    expect(f.drain).toHaveBeenCalledTimes(baseline);
    expect(f.registerGeneration).toHaveBeenCalledTimes(1);
  });
  it("tracks a new live WAITING event after resumption", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.query.mockResolvedValue(payload("done"));
    await f.relay.flush();
    const emit = (data: Record<string, unknown>) =>
      f.relay.handleGatewayEvent({
        type: "event",
        event: "agent",
        payload: {
          agentId: "main",
          sessionId: run.sessionId,
          runId: run.runId,
          stream: "lifecycle",
          data,
        },
      });
    emit({ phase: "start" });
    emit({ phase: "end", yielded: true, paused: true });
    await f.relay.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.events.map((e) => e.status)).toEqual([
      "RUNNING",
      "WAITING",
      "COMPLETED",
    ]);
  });
  it("retries local errors and stops polling on disconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.query.mockRejectedValue(new Error("offline"));
    await f.relay.flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.events).toEqual([]);
    f.relay.handleGatewayConnectionStateChange({ connected: false });
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it("does not overlap requests or overwrite a newer live event", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const f = fixture();
    f.query.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await f.relay.flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.query).toHaveBeenCalledTimes(1);
    f.relay.handleGatewayEvent({
      type: "event",
      event: "agent",
      payload: {
        agentId: "main",
        sessionId: run.sessionId,
        runId: run.runId,
        stream: "lifecycle",
        data: { phase: "start" },
      },
    });
    await f.relay.flush();
    resolve(payload("done"));
    await vi.advanceTimersByTimeAsync(0);
    await f.relay.flush();
    expect(f.events.map((e) => e.status)).toEqual(["RUNNING"]);
  });
});
