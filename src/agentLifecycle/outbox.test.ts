import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentLifecycleEvent } from "./contract.js";
import { createAgentLifecycleOutbox } from "./outbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-lifecycle-outbox-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function event(sequence: number): AgentLifecycleEvent {
  return {
    schemaVersion: 1,
    eventType: "agent.lifecycle.changed",
    eventId: `event-${sequence}`,
    serverId: "server-1",
    provider: "openclaw",
    sessionId: "session-1",
    runId: "run-1",
    sourceGeneration: "generation-1",
    sequence,
    status: sequence === 1 ? "RUNNING" : "COMPLETED",
    occurredAt: `2026-08-19T10:00:0${sequence}.000Z`,
    origin: "LIVE",
  };
}

describe("agent lifecycle durable outbox", () => {
  it("survives recreation, preserves order, and removes only acknowledged entries", async () => {
    const stateDir = await temporaryDirectory();
    const first = createAgentLifecycleOutbox({
      stateDir,
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });
    await first.enqueue(event(1));
    await first.enqueue(event(2));

    const restarted = createAgentLifecycleOutbox({ stateDir });
    const pending = await restarted.list();
    expect(pending.map((entry) => entry.event.sequence)).toEqual([1, 2]);

    await restarted.acknowledge(pending[0]);
    expect((await restarted.list()).map((entry) => entry.event.sequence)).toEqual([
      2,
    ]);
  });

  it("quarantines corrupt records instead of dropping valid entries", async () => {
    const stateDir = await temporaryDirectory();
    const pendingDir = path.join(
      stateDir,
      "relay",
      "agent-lifecycle-outbox",
      "pending",
    );
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, "broken.json"), "not-json", "utf8");
    const outbox = createAgentLifecycleOutbox({ stateDir });
    await outbox.enqueue(event(1));

    expect((await outbox.list()).map((entry) => entry.event.eventId)).toEqual([
      "event-1",
    ]);
    const quarantine = await fs.readdir(
      path.join(stateDir, "relay", "agent-lifecycle-outbox", "quarantine"),
    );
    expect(quarantine.some((name) => name.includes("broken.json"))).toBe(true);
  });

  it("quarantines every pending event from an abandoned generation", async () => {
    const stateDir = await temporaryDirectory();
    const outbox = createAgentLifecycleOutbox({ stateDir });
    await outbox.enqueue(event(1));
    await outbox.enqueue(event(2));

    await expect(
      outbox.quarantineGeneration?.("generation-1", "generation conflict"),
    ).resolves.toBe(2);
    expect(await outbox.list()).toEqual([]);
  });
});
