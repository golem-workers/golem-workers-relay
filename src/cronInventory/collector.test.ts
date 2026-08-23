import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCronInventoryCollector } from "./collector.js";
import { CRON_INVENTORY_MAX_BYTES } from "./contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

describe("relay cron inventory collector", () => {
  it("collects full OpenClaw and system inventory without exposing commands or targets", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cron-inventory-"));
    temporaryDirectories.push(directory);
    const cronD = path.join(directory, "cron.d");
    const spool = path.join(directory, "spool");
    const etcCrontab = path.join(directory, "crontab");
    await Promise.all([fs.mkdir(cronD), fs.mkdir(spool)]);
    await fs.writeFile(
      etcCrontab,
      "15 * * * * root curl -H 'Authorization: Bearer system-secret' https://example.test\n",
    );
    const request = vi.fn().mockResolvedValue({
      jobs: [{
        id: "job_1",
        name: "Safe name",
        description: "Safe description token=description-secret",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: 1,
        updatedAtMs: 2,
        schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "private-prompt-secret" },
        delivery: { mode: "announce", channel: "telegram", to: "private-target" },
        state: { nextRunAtMs: 10, lastError: "token=runtime-secret" },
      }],
      hasMore: false,
      nextOffset: null,
    });
    const collector = createCronInventoryCollector({
      gateway: { request },
      collectorVersion: "test-relay",
      now: () => new Date("2026-08-23T08:00:00.000Z"),
      paths: { etcCrontab, cronD, spool: [spool] },
    });

    const snapshot = await collector.collect({ requestId: "refresh-1" });
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.collectionStatus).toBe("COMPLETE");
    expect(snapshot.jobs).toHaveLength(2);
    expect(snapshot.requestId).toBe("refresh-1");
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      { includeDisabled: true, limit: 200, offset: 0 },
      { timeoutMs: 30_000 },
    );
    expect(serialized).not.toContain("private-prompt-secret");
    expect(serialized).not.toContain("private-target");
    expect(serialized).not.toContain("system-secret");
    expect(serialized).not.toContain("runtime-secret");
    expect(serialized).not.toContain("description-secret");
    expect(snapshot.jobs.find((job) => job.source === "OPENCLAW")?.openclawJob?.state.lastError)
      .toMatch(/^\[redacted:sha256:/);
  });

  it("retains malformed active system cron as INVALID without exposing its content", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cron-inventory-"));
    temporaryDirectories.push(directory);
    const cronD = path.join(directory, "cron.d");
    const spool = path.join(directory, "spool");
    const etcCrontab = path.join(directory, "crontab");
    await Promise.all([fs.mkdir(cronD), fs.mkdir(spool)]);
    await fs.writeFile(etcCrontab, "malformed inline-secret\n");
    const collector = createCronInventoryCollector({
      gateway: { request: vi.fn().mockResolvedValue({ jobs: [], hasMore: false, nextOffset: null }) },
      collectorVersion: "test-relay",
      paths: { etcCrontab, cronD, spool: [spool] },
    });

    const snapshot = await collector.collect();

    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({
      source: "SYSTEM",
      parseStatus: "INVALID",
      parseError: "Malformed system cron entry",
      schedule: { kind: "system", expression: "<invalid>" },
    });
    expect(JSON.stringify(snapshot)).not.toContain("inline-secret");
  });

  it("marks the snapshot PARTIAL when OpenClaw collection is unavailable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cron-inventory-"));
    temporaryDirectories.push(directory);
    const cronD = path.join(directory, "cron.d");
    const spool = path.join(directory, "spool");
    const etcCrontab = path.join(directory, "crontab");
    await Promise.all([fs.mkdir(cronD), fs.mkdir(spool)]);
    await fs.writeFile(etcCrontab, "0 * * * * root true\n");
    const collector = createCronInventoryCollector({
      gateway: { request: vi.fn().mockRejectedValue(new Error("gateway offline")) },
      collectorVersion: "test-relay",
      paths: { etcCrontab, cronD, spool: [spool] },
    });

    const snapshot = await collector.collect();

    expect(snapshot.collectionStatus).toBe("PARTIAL");
    expect(snapshot.errors).toContainEqual(expect.objectContaining({
      source: "OPENCLAW",
      code: "sourceUnavailable",
    }));
    expect(snapshot.jobs).toHaveLength(1);
  });

  it("bounds oversized snapshots and marks them PARTIAL", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cron-inventory-"));
    temporaryDirectories.push(directory);
    const cronD = path.join(directory, "cron.d");
    const spool = path.join(directory, "spool");
    const etcCrontab = path.join(directory, "crontab");
    await Promise.all([fs.mkdir(cronD), fs.mkdir(spool)]);
    await fs.writeFile(etcCrontab, "");
    const jobs = Array.from({ length: 1_200 }, (_, index) => ({
      id: `job_${index}`,
      name: `Job ${index}`,
      description: "x".repeat(2_000),
      enabled: true,
      deleteAfterRun: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "private" },
      state: {},
    }));
    const request = vi.fn((_method: string, paramsValue: unknown) => {
      const params = paramsValue as { offset: number; limit: number };
      const page = jobs.slice(params.offset, params.offset + params.limit);
      const nextOffset = params.offset + page.length;
      return Promise.resolve({
        jobs: page,
        hasMore: nextOffset < jobs.length,
        nextOffset: nextOffset < jobs.length ? nextOffset : null,
      });
    });
    const collector = createCronInventoryCollector({
      gateway: { request },
      collectorVersion: "test-relay",
      paths: { etcCrontab, cronD, spool: [spool] },
    });

    const snapshot = await collector.collect();

    expect(snapshot.collectionStatus).toBe("PARTIAL");
    expect(snapshot.jobs.length).toBeLessThan(jobs.length);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8"))
      .toBeLessThanOrEqual(CRON_INVENTORY_MAX_BYTES);
  });
});
