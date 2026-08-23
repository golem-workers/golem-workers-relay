import { describe, expect, it, vi } from "vitest";

import { buildCronInventoryConfigHash, type CronInventorySnapshot } from "./contract.js";
import { createCronInventorySync } from "./sync.js";
import type { CronInventoryState, CronInventoryStateStore } from "./stateStore.js";

function snapshot(requestId?: string): CronInventorySnapshot {
  return {
    schemaVersion: 1,
    collectorVersion: "test-relay",
    observedAt: "2026-08-23T08:00:00.000Z",
    configHash: buildCronInventoryConfigHash([]),
    collectionStatus: "COMPLETE",
    errors: [],
    ...(requestId ? { requestId } : {}),
    jobs: [],
  };
}

function memoryStore(initial?: Partial<CronInventoryState>) {
  let state: CronInventoryState = {
    schemaVersion: 1,
    lastAcknowledgedHash: null,
    lastAcknowledgedAt: null,
    pendingSnapshot: null,
    ...initial,
  };
  const load: CronInventoryStateStore["load"] = () => Promise.resolve(structuredClone(state));
  const save: CronInventoryStateStore["save"] = (next) => {
    state = structuredClone(next);
    return Promise.resolve();
  };
  const store: CronInventoryStateStore = {
    load: vi.fn(load),
    save: vi.fn(save),
  };
  return { store, read: () => state };
}

describe("cron inventory synchronization", () => {
  it("pushes first state, skips unchanged ticks, and force-pushes a correlated refresh", async () => {
    const storage = memoryStore();
    const collect = vi.fn((input?: { requestId?: string }) => Promise.resolve(snapshot(input?.requestId)));
    const submitCronInventory = vi.fn(({ snapshot: submitted }: { snapshot: CronInventorySnapshot }) => Promise.resolve({
      accepted: true as const,
      acceptedHash: submitted.configHash,
      inventoryVersion: 1,
      receivedAt: "2026-08-23T08:00:01.000Z",
    }));
    const sync = createCronInventorySync({
      collector: { collect },
      backend: { submitCronInventory },
      store: storage.store,
      intervalMs: 300_000,
      initialJitterMs: 30_000,
      retryBaseMs: 5_000,
      retryMaxMs: 300_000,
    });

    await sync.runOnce();
    await sync.runOnce();
    await sync.runOnce({ force: true, requestId: "refresh-1" });
    sync.stop();

    expect(submitCronInventory).toHaveBeenCalledTimes(2);
    expect(submitCronInventory.mock.calls[1]?.[0].snapshot.requestId).toBe("refresh-1");
    expect(storage.read().pendingSnapshot).toBeNull();
    expect(storage.read().lastAcknowledgedHash).toBe(snapshot().configHash);
  });

  it("keeps pending state when ACK is invalid", async () => {
    const storage = memoryStore();
    const sync = createCronInventorySync({
      collector: { collect: vi.fn(() => Promise.resolve(snapshot())) },
      backend: {
        submitCronInventory: vi.fn(() => Promise.resolve({
          accepted: true,
          acceptedHash: `sha256:${"f".repeat(64)}`,
          inventoryVersion: 1,
          receivedAt: "2026-08-23T08:00:01.000Z",
        })),
      },
      store: storage.store,
      intervalMs: 300_000,
      initialJitterMs: 0,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
    });

    await sync.runOnce();
    sync.stop();

    expect(storage.read().pendingSnapshot?.configHash).toBe(snapshot().configHash);
    expect(storage.read().lastAcknowledgedHash).toBeNull();
  });

  it("pushes a newer pending snapshot immediately after an in-flight ACK", async () => {
    const oldSnapshot = snapshot();
    const newSnapshot = {
      ...snapshot("refresh-new"),
      configHash: `sha256:${"a".repeat(64)}`,
    };
    const storage = memoryStore({ pendingSnapshot: oldSnapshot });
    let resolveFirst: ((value: {
      accepted: true;
      acceptedHash: string;
      inventoryVersion: number;
      receivedAt: string;
    }) => void) | undefined;
    const submitCronInventory = vi.fn(({ snapshot: submitted }: { snapshot: CronInventorySnapshot }) => {
      if (submitCronInventory.mock.calls.length === 1) {
        return new Promise<{
          accepted: true;
          acceptedHash: string;
          inventoryVersion: number;
          receivedAt: string;
        }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        accepted: true as const,
        acceptedHash: submitted.configHash,
        inventoryVersion: 2,
        receivedAt: "2026-08-23T08:00:02.000Z",
      });
    });
    const sync = createCronInventorySync({
      collector: { collect: vi.fn(() => Promise.resolve(newSnapshot)) },
      backend: { submitCronInventory },
      store: storage.store,
      intervalMs: 300_000,
      initialJitterMs: 300_000,
      retryBaseMs: 5_000,
      retryMaxMs: 300_000,
    });

    await sync.start();
    await vi.waitFor(() => expect(submitCronInventory).toHaveBeenCalledTimes(1));
    const collection = sync.runOnce({ force: true, requestId: "refresh-new" });
    await vi.waitFor(() => expect(storage.read().pendingSnapshot?.configHash).toBe(newSnapshot.configHash));
    resolveFirst?.({
      accepted: true,
      acceptedHash: oldSnapshot.configHash,
      inventoryVersion: 1,
      receivedAt: "2026-08-23T08:00:01.000Z",
    });
    await collection;
    await vi.waitFor(() => expect(submitCronInventory).toHaveBeenCalledTimes(2));
    sync.stop();

    expect(storage.read().lastAcknowledgedHash).toBe(newSnapshot.configHash);
    expect(storage.read().pendingSnapshot).toBeNull();
  });
});
