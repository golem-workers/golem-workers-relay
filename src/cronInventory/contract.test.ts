import { describe, expect, it } from "vitest";

import {
  buildCronInventoryConfigHash,
  type CronInventoryEntry,
} from "./contract.js";

function entry(id: string, fingerprint = `sha256:${"a".repeat(64)}`): CronInventoryEntry {
  return {
    source: "SYSTEM",
    sourceId: id,
    name: id,
    description: null,
    enabled: true,
    schedule: { kind: "system", expression: "0 * * * *" },
    timezone: "UTC",
    nextRunAtMs: 1_000,
    parseStatus: "SUPPORTED",
    parseError: null,
    configFingerprint: fingerprint,
    system: {
      sourcePath: "/etc/crontab",
      line: 1,
      user: "root",
      fingerprint,
    },
  };
}

describe("cron inventory canonical hash", () => {
  it("matches the shared backend fixture", () => {
    expect(buildCronInventoryConfigHash([
      entry("second", `sha256:${"b".repeat(64)}`),
      entry("first", `sha256:${"a".repeat(64)}`),
    ])).toBe("sha256:12e32aeac21c75b7667a24b88877bd9fbd41e84fb2ffe8e5de69146b4ff9bfdc");
  });

  it("is stable across job order and runtime-only changes", () => {
    const first = entry("first");
    const second = entry("second", `sha256:${"b".repeat(64)}`);
    const hash = buildCronInventoryConfigHash([first, second]);

    expect(buildCronInventoryConfigHash([
      { ...second, nextRunAtMs: 9_999, parseError: "runtime diagnostic" },
      { ...first, nextRunAtMs: null },
    ])).toBe(hash);
  });

  it("changes for enabled, schedule, or safe config fingerprint changes", () => {
    const base = entry("job");
    const hash = buildCronInventoryConfigHash([base]);

    expect(buildCronInventoryConfigHash([{ ...base, enabled: false }])).not.toBe(hash);
    expect(buildCronInventoryConfigHash([{
      ...base,
      schedule: { kind: "system", expression: "15 * * * *" },
    }])).not.toBe(hash);
    expect(buildCronInventoryConfigHash([{
      ...base,
      configFingerprint: `sha256:${"c".repeat(64)}`,
    }])).not.toBe(hash);
  });
});
