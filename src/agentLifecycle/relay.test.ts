import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentLifecycleBackend } from "./backendClient.js";
import type {
  AgentLifecycleOutbox,
  PendingAgentLifecycleEvent,
} from "./outbox.js";
import type { AgentLifecyclePublisher } from "./publisher.js";
import { createAgentLifecycleRelay } from "./relay.js";
import type { AgentLifecycleSourceStore } from "./sourceStore.js";
import type { AgentLifecycleSourceState } from "./sourceStore.js";

describe("agent lifecycle relay", () => {
  afterEach(() => vi.useRealTimers());

  it("emits only changes through the isolated durable contour", async () => {
    const pending: PendingAgentLifecycleEvent[] = [];
    let registrationCount = 0;
    const backend: AgentLifecycleBackend = {
      registerGeneration({ sourceGeneration }) {
        registrationCount += 1;
        return Promise.resolve({
          accepted: true,
          disposition: "ACTIVATED" as const,
          serverId: "server-1",
          sourceGeneration,
          generationOrdinal: 1,
          activeRuns: [],
        });
      },
      submitEvent: vi.fn<AgentLifecycleBackend["submitEvent"]>(),
    };
    const outbox: AgentLifecycleOutbox = {
      enqueue(event) {
        const entry = {
          fileName: `${event.eventId}.json`,
          enqueuedAt: event.occurredAt,
          event,
        };
        pending.push(entry);
        return Promise.resolve(entry);
      },
      list: () => Promise.resolve([...pending]),
      acknowledge: () => Promise.resolve(),
      quarantine: () => Promise.resolve(),
    };
    const publisher: AgentLifecyclePublisher = {
      publish: vi.fn(),
      drain: vi.fn(() =>
        Promise.resolve({
          acknowledged: 0,
          pending: pending.length,
          blocked: false,
        }),
      ),
    };
    let stored: AgentLifecycleSourceState | null = null;
    const sourceStore: AgentLifecycleSourceStore = {
      load: () => Promise.resolve(stored),
      save(state) {
        stored = state;
        return Promise.resolve();
      },
    };
    const relay = createAgentLifecycleRelay({
      backend,
      outbox,
      publisher,
      sourceStore,
      subscribeLifecycleEvents: vi.fn(() => Promise.resolve()),
      generationId: () => "generation-1",
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    relay.handleGatewayConnectionStateChange({ connected: true });
    relay.handleGatewayEvent(frame("start", 1));
    relay.handleGatewayEvent(frame("start", 2));
    relay.handleGatewayEvent(frame("end", 3));
    relay.handleGatewayEvent({
      type: "event",
      event: "agent",
      payload: {
        runId: "run-1",
        sessionId: "session-1",
        stream: "assistant",
        data: { delta: "ignored" },
      },
    });
    await relay.flush();

    expect(registrationCount).toBe(1);
    expect(pending.map((entry) => entry.event.status)).toEqual([
      "RUNNING",
      "COMPLETED",
    ]);
    expect(pending.map((entry) => entry.event.sequence)).toEqual([1, 2]);
  });

  it("subscribes before generation activation and retries a rejected subscription", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const subscribeLifecycleEvents = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        calls.push("subscribe-failed");
        return Promise.reject(new Error("not ready"));
      })
      .mockImplementation(() => {
        calls.push("subscribe");
        return Promise.resolve();
      });
    const registerGeneration = vi.fn<AgentLifecycleBackend["registerGeneration"]>(
      ({ sourceGeneration }) => {
        calls.push("register");
        return Promise.resolve({
          accepted: true,
          disposition: "ACTIVATED",
          serverId: "server-1",
          sourceGeneration,
          generationOrdinal: 1,
          activeRuns: [],
        });
      },
    );
    const relay = createAgentLifecycleRelay({
      backend: {
        registerGeneration,
        submitEvent: vi.fn<AgentLifecycleBackend["submitEvent"]>(),
      },
      outbox: {
        enqueue: vi.fn<AgentLifecycleOutbox["enqueue"]>(),
        list: () => Promise.resolve([]),
        acknowledge: vi.fn<AgentLifecycleOutbox["acknowledge"]>(),
        quarantine: vi.fn<AgentLifecycleOutbox["quarantine"]>(),
      },
      publisher: {
        publish: vi.fn(),
        drain: () =>
          Promise.resolve({ acknowledged: 0, pending: 0, blocked: false }),
      },
      sourceStore: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
      },
      subscribeLifecycleEvents,
      generationId: () => "generation-1",
    });

    relay.handleGatewayConnectionStateChange({ connected: true });
    await relay.flush();
    expect(registerGeneration).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await relay.flush();

    expect(calls).toEqual(["subscribe-failed", "subscribe", "register"]);
    expect(registerGeneration).toHaveBeenCalledOnce();
  });

  it("reconciles a disappeared run once on connection without polling", async () => {
    const pending: PendingAgentLifecycleEvent[] = [];
    const backend: AgentLifecycleBackend = {
      registerGeneration: ({ sourceGeneration }) =>
        Promise.resolve({
          accepted: true,
          disposition: "ACTIVATED",
          serverId: "server-1",
          sourceGeneration,
          generationOrdinal: 2,
          activeRuns: [
            {
              provider: "openclaw",
              agentId: null,
              sessionId: "session-old",
              runId: "run-old",
              status: "RUNNING",
            },
          ],
        }),
      submitEvent: vi.fn<AgentLifecycleBackend["submitEvent"]>(),
    };
    const outbox: AgentLifecycleOutbox = {
      enqueue(event) {
        const entry = {
          fileName: `${event.eventId}.json`,
          enqueuedAt: event.occurredAt,
          event,
        };
        pending.push(entry);
        return Promise.resolve(entry);
      },
      list: () => Promise.resolve([...pending]),
      acknowledge: () => Promise.resolve(),
      quarantine: () => Promise.resolve(),
    };
    const drain = vi.fn(() =>
      Promise.resolve({
        acknowledged: 0,
        pending: pending.length,
        blocked: false,
      }),
    );
    const sourceStore: AgentLifecycleSourceStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
    };
    const queryActiveRuns = vi.fn(() => Promise.resolve([]));
    const relay = createAgentLifecycleRelay({
      backend,
      outbox,
      publisher: { publish: vi.fn(), drain },
      sourceStore,
      queryActiveRuns,
      generationId: () => "generation-2",
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    relay.handleGatewayConnectionStateChange({ connected: true });
    relay.handleGatewayConnectionStateChange({ connected: true });
    await relay.flush();

    expect(queryActiveRuns).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.event).toMatchObject({
      runId: "run-old",
      status: "CANCELLED",
      origin: "RECONCILIATION",
      sequence: 1,
    });
  });

  it("replays an old generation before rotating and retries only while pending", async () => {
    vi.useFakeTimers();
    const stored: AgentLifecycleSourceState = {
      schemaVersion: 1,
      serverId: "server-1",
      sourceGeneration: "generation-old",
      registered: true,
      updatedAt: "2026-08-19T09:59:00.000Z",
    };
    const registerGeneration = vi.fn<AgentLifecycleBackend["registerGeneration"]>(
      ({ sourceGeneration }) =>
        Promise.resolve({
          accepted: true,
          disposition: "ACTIVATED" as const,
          serverId: "server-1",
          sourceGeneration,
          generationOrdinal: 2,
          activeRuns: [],
        }),
    );
    const backend: AgentLifecycleBackend = {
      registerGeneration,
      submitEvent: vi.fn<AgentLifecycleBackend["submitEvent"]>(),
    };
    const outbox: AgentLifecycleOutbox = {
      enqueue: vi.fn<AgentLifecycleOutbox["enqueue"]>(),
      list: vi.fn<AgentLifecycleOutbox["list"]>(),
      acknowledge: vi.fn<AgentLifecycleOutbox["acknowledge"]>(),
      quarantine: vi.fn<AgentLifecycleOutbox["quarantine"]>(),
    };
    const drain = vi
      .fn<AgentLifecyclePublisher["drain"]>()
      .mockResolvedValueOnce({ acknowledged: 0, pending: 1, blocked: true })
      .mockResolvedValue({ acknowledged: 1, pending: 0, blocked: false });
    const relay = createAgentLifecycleRelay({
      backend,
      outbox,
      publisher: { publish: vi.fn(), drain },
      sourceStore: {
        load: () => Promise.resolve(stored),
        save: () => Promise.resolve(),
      },
      generationId: () => "generation-new",
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    relay.handleGatewayConnectionStateChange({ connected: true });
    await relay.flush();
    expect(registerGeneration).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await relay.flush();
    expect(registerGeneration).toHaveBeenCalledOnce();
    expect(registerGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ sourceGeneration: "generation-new" }),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await relay.flush();
    expect(drain).toHaveBeenCalledTimes(3);
  });
});

function frame(phase: "start" | "end", seq: number) {
  return {
    type: "event" as const,
    event: "agent",
    payload: {
      runId: "run-1",
      sessionId: "session-1",
      stream: "lifecycle",
      ts: Date.parse(`2026-08-19T10:00:0${seq}.000Z`),
      data: { phase },
    },
  };
}
