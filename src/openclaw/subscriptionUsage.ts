import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readSubscriptionRuntime,
  subscriptionSnapshotSchema,
  type SubscriptionSnapshot,
} from "./subscriptionRuntime.js";
import { readSubscriptionInventory } from "./subscriptionInventory.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type SubscriptionUsageEvent = {
  eventId: string;
  sessionId: string;
  sessionKeyHash: string;
  requestId: string;
  messageId: string;
  profileId?: string;
  basis: "SESSION_WINDOW" | "UNKNOWN";
  reason?: string;
  startedAt: string;
  completedAt: string;
  at: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};
type Pending = {
  id: string;
  sessionKey: string;
  startedAt: string;
  before: SubscriptionSnapshot;
  overlap: boolean;
};
type State = {
  version: 1;
  pending: Pending[];
  events: SubscriptionUsageEvent[];
  observingSince: string;
  observedEventIds: string[];
  sessionCursors: Record<string, number>;
};
const pendingSchema = z.object({
  id: z.string(),
  sessionKey: z.string(),
  startedAt: z.string(),
  before: subscriptionSnapshotSchema,
  overlap: z.boolean(),
});
const eventSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  sessionKeyHash: z.string(),
  requestId: z.string(),
  messageId: z.string(),
  profileId: z.string().optional(),
  basis: z.enum(["SESSION_WINDOW", "UNKNOWN"]),
  reason: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string(),
  at: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  total: z.number(),
});
const stateSchema = z.object({
  version: z.literal(1),
  pending: z.array(pendingSchema),
  events: z.array(eventSchema),
  observingSince: z.string().datetime().default(() => new Date().toISOString()),
  observedEventIds: z.array(z.string()).max(200000).default([]),
  sessionCursors: z.record(z.string(), z.number().int().nonnegative().safe()).default({}),
});
export function deriveSubscriptionUsage(
  p: Pending,
  after: SubscriptionSnapshot,
  succeeded: boolean,
  restarted = false,
): SubscriptionUsageEvent[] {
  const seen = new Set(p.before.rows.map((r) => r.messageId));
  const rows = after.rows.filter((r) => !seen.has(r.messageId));
  const reason = restarted
    ? "RESTART_WINDOW"
    : p.overlap
      ? "OVERLAPPING_REQUESTS"
      : !succeeded
        ? "REQUEST_ERROR"
        : p.before.sessionId && p.before.sessionId !== after.sessionId
          ? "SESSION_CHANGED"
          : rows.length !== 1
            ? "MULTIPLE_MESSAGES"
            : !after.profileId
              ? "PROFILE_UNKNOWN"
              : after.activeRunId
                ? "ACTIVE_WRITER"
                : undefined;
  return rows.map(r => ({
    eventId: hash(`${after.sessionId}\0${r.messageId}`),
    sessionId: after.sessionId!,
    sessionKeyHash: hash(p.sessionKey),
    requestId: hash(p.id),
    profileId: reason ? undefined : after.profileId,
    basis: reason ? "UNKNOWN" : "SESSION_WINDOW",
    reason,
    startedAt: p.startedAt,
    completedAt: new Date(after.observedAtMs).toISOString(),
    at: r.at, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, total: r.total, messageId: r.messageId,
  }));
}
/** Local write-ahead outbox. Failures never cause another model request or billing fallback. */
export function createSubscriptionUsageCollector(opts: {
  backend: {
    submitSubscriptionUsageEvents(body: {
      events: SubscriptionUsageEvent[];
    }): Promise<unknown>;
  };
  statePath?: string;
  read?: typeof readSubscriptionRuntime;
  inventory?: typeof readSubscriptionInventory;
}) {
  const file =
    opts.statePath ??
    path.join(resolveOpenclawStateDir(), "golem-subscription-usage.json");
  const read = opts.read ?? readSubscriptionRuntime;
  const inventory = opts.inventory ?? readSubscriptionInventory;
  let state: State | undefined,
    tail: Promise<unknown> = Promise.resolve(),
    recovered = false;

  async function load() {
    if (!state) {
      try {
        state = stateSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = { version: 1, pending: [], events: [], observingSince: new Date().toISOString(), observedEventIds: [], sessionCursors: {} };
      }
    }
    for (const event of state.events) if (!state.observedEventIds.includes(event.eventId)) state.observedEventIds.push(event.eventId);
    return state;
  }
  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + "." + randomUUID();
    const handle = await fs.open(tmp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  function locked<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  }
  async function append(events: SubscriptionUsageEvent[]) {
    const s = await load();
    const seen = new Set(s.observedEventIds);
    for (const event of events) {
      if (seen.has(event.eventId)) continue;
      if (seen.size >= 200000) throw new Error("SUBSCRIPTION_USAGE_OBSERVER_LIMIT");
      seen.add(event.eventId); s.events.push(event); s.observedEventIds.push(event.eventId);
    }
  }
  async function observeSettledSessions() {
    const s = await load();
    const sinceMs = Date.parse(s.observingSince);
    const snapshots = await inventory({ sinceMs, after: s.sessionCursors });
    for (const { sessionKey, snapshot } of snapshots) {
      if (!snapshot.sessionId || snapshot.activeRunId || s.pending.some(p => p.sessionKey === sessionKey)) continue;
      const events = snapshot.rows.filter(r => Date.parse(r.at) >= sinceMs).map(r => ({
        eventId: hash(`${snapshot.sessionId}\0${r.messageId}`),
        sessionId: snapshot.sessionId!, sessionKeyHash: hash(sessionKey),
        requestId: hash(`transcript-observation\0${snapshot.sessionId}\0${r.messageId}`),
        messageId: r.messageId, basis: "UNKNOWN" as const, reason: "SETTLED_TRANSCRIPT_NO_DISPATCH_PROOF",
        startedAt: r.at, completedAt: new Date(snapshot.observedAtMs).toISOString(),
        at: r.at, model: r.model, input: r.input, output: r.output,
        cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, total: r.total,
      }));
      await append(events);
      // Advance only after a complete settled inventory, never from a newer
      // Relay window that could otherwise skip earlier unseen native messages.
      if (events.length) s.sessionCursors[`session:${snapshot.sessionId}`] = Math.max(
        s.sessionCursors[`session:${snapshot.sessionId}`] ?? sinceMs,
        ...events.map(event => Date.parse(event.at)),
      );
    }
    await save();
  }
  async function recover() {
    if (recovered) return;
    const s = await load();
    for (const p of [...s.pending]) {
      const after = await read({ sessionKey: p.sessionKey });
      if (!after) continue;
      await append(deriveSubscriptionUsage(p, after, false, true));
      s.pending = s.pending.filter((x) => x.id !== p.id);
    }
    await save();
    recovered = true;
  }
  return {
    async begin(sessionKey: string) {
      return locked(async () => {
        await recover();
        const before = await read({ sessionKey });
        if (!before) return null;
        const s = await load();
        const p: Pending = {
          id: randomUUID(),
          sessionKey,
          startedAt: new Date().toISOString(),
          before,
          overlap: s.pending.some((x) => x.sessionKey === sessionKey),
        };
        if (p.overlap)
          for (const other of s.pending)
            if (other.sessionKey === sessionKey) other.overlap = true;
        s.pending.push(p);
        await save();
        return p.id;
      });
    },
    async finish(id: string | null, succeeded: boolean) {
      if (!id) return;
      return locked(async () => {
        const s = await load();
        const p = s.pending.find((x) => x.id === id);
        if (!p) return;
        const after = await read({ sessionKey: p.sessionKey });
        if (!after) return;
        await append(deriveSubscriptionUsage(p, after, succeeded));
        s.pending = s.pending.filter((x) => x.id !== id);
        await save();
      });
    },
    async flush() {
      return locked(async () => {
        await recover();
        const s = await load();
        let inventoryError: unknown;
        try { await observeSettledSessions(); } catch (error) { inventoryError = error; }
        while (s.events.length) {
          const batch = s.events.slice(0, 100);
          await opts.backend.submitSubscriptionUsageEvents({ events: batch });
          s.events.splice(0, batch.length);
          await save();
        }
        if (inventoryError) throw inventoryError instanceof Error ? inventoryError : new Error("SUBSCRIPTION_INVENTORY_READ_FAILED");
      });
    },
  };
}
export type SubscriptionUsageCollector = ReturnType<
  typeof createSubscriptionUsageCollector
>;
