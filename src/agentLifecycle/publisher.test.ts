import { describe, expect, it, vi } from "vitest";

import {
  AgentLifecycleBackendHttpError,
  type AgentLifecycleBackend,
} from "./backendClient.js";
import type { AgentLifecycleEvent } from "./contract.js";
import type {
  AgentLifecycleOutbox,
  PendingAgentLifecycleEvent,
} from "./outbox.js";
import { createAgentLifecyclePublisher } from "./publisher.js";

const lifecycleEvent: AgentLifecycleEvent = {
  schemaVersion: 1,
  eventType: "agent.lifecycle.changed",
  eventId: "event-1",
  serverId: "server-1",
  provider: "openclaw",
  sessionId: "session-1",
  runId: "run-1",
  sourceGeneration: "generation-1",
  sequence: 1,
  status: "RUNNING",
  occurredAt: "2026-08-19T10:00:00.000Z",
  origin: "LIVE",
};

function harness() {
  const entries: PendingAgentLifecycleEvent[] = [];
  const quarantined: PendingAgentLifecycleEvent[] = [];
  const outbox: AgentLifecycleOutbox = {
    enqueue(event) {
      const entry = {
        fileName: `${event.eventId}.json`,
        enqueuedAt: event.occurredAt,
        event,
      };
      if (!entries.some((current) => current.fileName === entry.fileName)) {
        entries.push(entry);
      }
      return Promise.resolve(entry);
    },
    list: () => Promise.resolve([...entries]),
    acknowledge(entry) {
      entries.splice(entries.indexOf(entry), 1);
      return Promise.resolve();
    },
    quarantine(entry) {
      entries.splice(entries.indexOf(entry), 1);
      quarantined.push(entry);
      return Promise.resolve();
    },
  };
  const submitEvent = vi.fn<AgentLifecycleBackend["submitEvent"]>();
  const backend: AgentLifecycleBackend = {
    registerGeneration: vi.fn<AgentLifecycleBackend["registerGeneration"]>(),
    submitEvent: (event) => submitEvent(event),
  };
  return { entries, quarantined, outbox, backend, submitEvent };
}

describe("agent lifecycle publisher", () => {
  it("retains an event on transport failure and acknowledges it on a later drain", async () => {
    const test = harness();
    test.submitEvent.mockRejectedValueOnce(new Error("offline"));
    test.submitEvent.mockResolvedValueOnce({
      accepted: true,
      disposition: "APPLIED",
      eventId: lifecycleEvent.eventId,
    });
    const publisher = createAgentLifecyclePublisher(test);

    expect(await publisher.publish(lifecycleEvent)).toMatchObject({
      pending: 1,
      blocked: true,
    });
    expect(await publisher.drain()).toMatchObject({
      acknowledged: 1,
      pending: 0,
      blocked: false,
    });
  });

  it("quarantines a permanently rejected event and continues the ordered drain", async () => {
    const test = harness();
    test.submitEvent.mockRejectedValue(
      new AgentLifecycleBackendHttpError(422, "invalid"),
    );
    const publisher = createAgentLifecyclePublisher(test);

    const result = await publisher.publish(lifecycleEvent);
    expect(result).toMatchObject({ pending: 0, blocked: false });
    expect(test.quarantined).toHaveLength(1);
  });

  it("retains authentication failures for delivery after credentials recover", async () => {
    const test = harness();
    test.submitEvent.mockRejectedValue(
      new AgentLifecycleBackendHttpError(401, "expired relay token"),
    );
    const publisher = createAgentLifecyclePublisher(test);

    await expect(publisher.publish(lifecycleEvent)).resolves.toMatchObject({
      pending: 1,
      blocked: true,
    });
    expect(test.quarantined).toHaveLength(0);
    expect(test.entries).toHaveLength(1);
  });

  it("surfaces a sequence gap as a targeted reconciliation trigger", async () => {
    const test = harness();
    test.submitEvent.mockRejectedValue(
      new AgentLifecycleBackendHttpError(
        409,
        "gap",
        "AGENT_LIFECYCLE_SEQUENCE_GAP",
      ),
    );
    const publisher = createAgentLifecyclePublisher(test);

    await expect(publisher.publish(lifecycleEvent)).resolves.toMatchObject({
      blocked: true,
      anomaly: "SEQUENCE_GAP",
    });
    expect(test.entries).toHaveLength(1);
  });

  it.each([
    "AGENT_LIFECYCLE_TRANSITION_CONFLICT",
    "AGENT_LIFECYCLE_IDEMPOTENCY_CONFLICT",
  ])("quarantines %s and requests generation rotation", async (code) => {
    const test = harness();
    test.submitEvent.mockRejectedValue(
      new AgentLifecycleBackendHttpError(409, "conflict", code),
    );
    const publisher = createAgentLifecyclePublisher(test);

    await expect(publisher.publish(lifecycleEvent)).resolves.toMatchObject({
      pending: 0,
      blocked: true,
      anomaly: "GENERATION_CONFLICT",
    });
    expect(test.quarantined).toHaveLength(1);
  });
});
