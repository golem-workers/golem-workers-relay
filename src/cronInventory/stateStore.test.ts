import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildCronInventoryConfigHash, type CronInventorySnapshot } from "./contract.js";
import { createCronInventoryStateStore } from "./stateStore.js";

describe("cron inventory state store", () => {
  it("persists a pending snapshot and acknowledged state across restart", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-inventory-state-"));
    try {
      const configHash = buildCronInventoryConfigHash([]);
      const snapshot: CronInventorySnapshot = {
        schemaVersion: 1,
        collectorVersion: "test",
        observedAt: "2026-08-23T08:00:00.000Z",
        configHash,
        collectionStatus: "COMPLETE",
        errors: [],
        jobs: [],
      };
      const first = createCronInventoryStateStore({ stateDir });
      await first.save({
        schemaVersion: 1,
        lastAcknowledgedHash: configHash,
        lastAcknowledgedAt: "2026-08-23T08:00:01.000Z",
        pendingSnapshot: snapshot,
      });

      const restarted = createCronInventoryStateStore({ stateDir });
      expect(await restarted.load()).toEqual({
        schemaVersion: 1,
        lastAcknowledgedHash: configHash,
        lastAcknowledgedAt: "2026-08-23T08:00:01.000Z",
        pendingSnapshot: snapshot,
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
