import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type SubscriptionUsageEvent,
  createSubscriptionUsageCollector,
  deriveSubscriptionUsage,
} from "./subscriptionUsage.js";
import type { SubscriptionSnapshot } from "./subscriptionRuntime.js";
const snap = (
  rows: SubscriptionSnapshot["rows"] = [],
  profileId = "openai:golem-a",
): SubscriptionSnapshot => ({
  observedAtMs: Date.now(),
  sessionId: "same",
  profileId,
  source: "auto",
  clearedAutoPin: false,
  revision: 1,
  rows,
});
const row = {
  messageId: "message",
  at: new Date().toISOString(),
  model: "test",
  input: 10,
  output: 2,
  cacheRead: 100,
  cacheWrite: 0,
  total: 112,
  stopReason: "stop",
};
const pending = () => ({
  id: "request",
  sessionKey: "agent:main:s",
  startedAt: new Date().toISOString(),
  before: snap(),
  overlap: false,
});
it("uses end-of-run historical pin rather than the current enabled pool and keeps cache counters distinct", () => {
  const result = deriveSubscriptionUsage(
    pending(),
    { ...snap([row]), revision: 2 },
    true,
  )[0];
  expect(result).toMatchObject({
    profileId: "openai:golem-a",
    basis: "SESSION_WINDOW",
    total: 112,
    input: 10,
    cacheRead: 100,
  });
  expect(result).not.toHaveProperty("stopReason");
  expect(
    deriveSubscriptionUsage(pending(), snap([row], "openai:golem-b"), true)[0]
      .eventId,
  ).toBe(result.eventId);
});
it.each(["overlap", "error", "restart", "multiple", "missing", "changed"])(
  "retains ambiguous %s usage without guessing",
  (reason) => {
    const p = pending();
    const after = snap([row]);
    if (reason === "overlap") p.overlap = true;
    if (reason === "multiple") after.rows.push({ ...row, messageId: "two" });
    if (reason === "missing") delete after.profileId;
    if (reason === "changed") after.sessionId = "another";
    const result = deriveSubscriptionUsage(
      p,
      after,
      reason !== "error",
      reason === "restart",
    );
    expect(result.every((e) => e.basis === "UNKNOWN" && !e.profileId)).toBe(
      true,
    );
    expect(result[0].total).toBe(112);
  },
);
let root: string | undefined;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it("persists failed delivery across collector restart and replays the same message key", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-outbox-"));
  let current = snap();
  const read = vi.fn(() => Promise.resolve(current));
  const send = vi
    .fn()
    .mockRejectedValueOnce(Error("offline"))
    .mockResolvedValue({ accepted: true });
  const opts = {
    statePath: path.join(root, "outbox"),
    inventory: () => Promise.resolve([]),
    read,
    backend: { submitSubscriptionUsageEvents: send },
  };
  const first = createSubscriptionUsageCollector(opts);
  const id = await first.begin("agent:main:s");
  current = snap([row]);
  await first.finish(id, true);
  await expect(first.flush()).rejects.toThrow("offline");
  const second = createSubscriptionUsageCollector(opts);
  await second.flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0][0]).toEqual(send.mock.calls[1][0]);
  expect((JSON.parse(await fs.readFile(opts.statePath, "utf8")) as {events: unknown[]}).events).toEqual(
    [],
  );
});
it("recovers an interrupted request as unknown without reclassifying it from the latest pin", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-recovery-"));
  let current = snap();
  const send = vi.fn<(body: {events: SubscriptionUsageEvent[]}) => Promise<unknown>>().mockResolvedValue({ accepted: true });
  const opts = {
    statePath: path.join(root, "outbox"),
    inventory: () => Promise.resolve([]),
    read: () => Promise.resolve(current),
    backend: { submitSubscriptionUsageEvents: send },
  };
  await createSubscriptionUsageCollector(opts).begin("agent:main:s");
  current = snap([row], "openai:golem-b");
  await createSubscriptionUsageCollector(opts).flush();
  expect(send.mock.calls[0][0].events[0]).toMatchObject({
    basis: "UNKNOWN",
    reason: "RESTART_WINDOW",
  });
});
it("marks both concurrent same-session observations unknown", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-race-"));
  let current = snap();
  const send = vi.fn<(body: {events: SubscriptionUsageEvent[]}) => Promise<unknown>>().mockResolvedValue({ accepted: true });
  const c = createSubscriptionUsageCollector({
    statePath: path.join(root, "outbox"),
    inventory: () => Promise.resolve([]),
    read: () => Promise.resolve(current),
    backend: { submitSubscriptionUsageEvents: send },
  });
  const a = await c.begin("s"),
    b = await c.begin("s");
  current = snap([row]);
  await c.finish(a, true);
  await c.finish(b, true);
  await c.flush();
  expect(
    send.mock.calls[0][0].events.every(
      (e: { basis: string }) => e.basis === "UNKNOWN",
    ),
  ).toBe(true);
});

it('observes persisted native/cron/nested messages as UNKNOWN and deduplicates them across restart and Relay windows', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-inventory-'));
  const now = Date.now(); const message = { ...row, at: new Date(now).toISOString() };
  let current = { ...snap(), observedAtMs: now + 10 };
  const send = vi.fn<(body: {events: SubscriptionUsageEvent[]}) => Promise<unknown>>().mockResolvedValue({ accepted: true });
  const inventory = vi.fn(() => Promise.resolve([{ sessionKey: 'agent:main:cron:native', snapshot: { ...snap([message], 'latest-pin-not-proof'), observedAtMs: now + 100 } }]));
  const opts = { statePath: path.join(root, 'outbox'), read: () => Promise.resolve(current), inventory, backend: { submitSubscriptionUsageEvents: send } };
  const collector = createSubscriptionUsageCollector(opts);
  const id = await collector.begin('agent:main:relay');
  // Start observation at a known pre-message boundary without importing old history.
  const state = JSON.parse(await fs.readFile(opts.statePath, 'utf8')) as {observingSince: string};
  expect(Date.parse(state.observingSince)).toBeLessThanOrEqual(Date.now());
  // A live Relay request owns its own session window; inventory of another key
  // sharing the transcript is still immutable-message deduplicated.
  current = { ...snap([{ ...message, at: new Date(Date.now() + 5).toISOString() }]), observedAtMs: Date.now() + 100 };
  await collector.finish(id, true);
  inventory.mockResolvedValue([{ sessionKey: "agent:main:cron:native", snapshot: current }]);
  await collector.flush();
  expect(send.mock.calls.flatMap(c => c[0].events)).toHaveLength(1);
  await createSubscriptionUsageCollector(opts).flush();
  expect(send).toHaveBeenCalledTimes(1);
  const durable = JSON.parse(await fs.readFile(opts.statePath, "utf8")) as {sessionCursors: Record<string, number>};
  expect(durable.sessionCursors["session:same"]).toBe(Date.parse(current.rows[0].at));
  // A distinct native response never inherits the current session pin.
  const native = { ...message, messageId: 'native-response', at: new Date(Date.now()).toISOString() };
  inventory.mockResolvedValue([{ sessionKey: 'agent:worker:subagent:native', snapshot: { ...snap([native], 'latest-pin-not-proof'), observedAtMs: Date.now() + 100 } }]);
  await createSubscriptionUsageCollector(opts).flush();
  expect(send.mock.calls[1][0].events[0]).toMatchObject({ basis: 'UNKNOWN', reason: 'SETTLED_TRANSCRIPT_NO_DISPATCH_PROOF', total: 112 });
  expect(send.mock.calls[1][0].events[0]).not.toHaveProperty('profileId');
});

it('does not consume active writers, pending Relay windows or pre-observation history', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-inventory-pending-'));
  const now = Date.now();
  const send = vi.fn().mockResolvedValue({ accepted: true });
  const inventory = vi.fn(() => Promise.resolve([
    { sessionKey: 'active', snapshot: { ...snap([{ ...row, at: new Date(now + 100).toISOString() }]), activeRunId: 'writer' } },
    { sessionKey: 'pending', snapshot: snap([{ ...row, at: new Date(now + 100).toISOString() }]) },
    { sessionKey: 'old', snapshot: snap([{ ...row, at: new Date(now - 60000).toISOString() }]) },
  ]));
  const c = createSubscriptionUsageCollector({ statePath: path.join(root, 'outbox'), read: () => Promise.resolve(snap()), inventory, backend: { submitSubscriptionUsageEvents: send } });
  await c.begin('pending'); await c.flush(); expect(send).not.toHaveBeenCalled();
});

it('still flushes durable Relay events when the public inventory reader fails', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-inventory-failure-'));
  let current = snap(); const send = vi.fn().mockResolvedValue({ accepted: true });
  const c = createSubscriptionUsageCollector({ statePath: path.join(root, 'outbox'), read: () => Promise.resolve(current),
    inventory: () => Promise.reject(new Error('SUBSCRIPTION_INVENTORY_READ_FAILED')), backend: { submitSubscriptionUsageEvents: send } });
  const id = await c.begin('relay'); current = snap([row]); await c.finish(id, true);
  await expect(c.flush()).rejects.toThrow('SUBSCRIPTION_INVENTORY_READ_FAILED');
  expect(send).toHaveBeenCalledTimes(1);
});
