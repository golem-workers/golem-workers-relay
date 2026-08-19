import { createHash } from "node:crypto";
import { z } from "zod";

import type { EventFrame } from "../openclaw/protocol.js";

const agentEventPayloadSchema = z
  .object({
    runId: z.string().min(1),
    seq: z.number().int().nonnegative().optional(),
    stream: z.string().min(1),
    ts: z.number().finite().optional(),
    data: z.record(z.string(), z.unknown()),
    sessionKey: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
  })
  .passthrough();

const sessionsChangedPayloadSchema = z
  .object({
    sessionKey: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    phase: z.enum(["start", "end", "error"]),
    runId: z.string().min(1),
    ts: z.number().finite().optional(),
    status: z
      .enum(["running", "done", "failed", "killed", "timeout"])
      .optional(),
    abortedLastRun: z.boolean().optional(),
    session: z
      .object({
        sessionId: z.string().min(1).optional(),
        status: z
          .enum(["running", "done", "failed", "killed", "timeout"])
          .optional(),
        abortedLastRun: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type OpenClawLifecycleSignal = Readonly<{
  signal: unknown;
  sessionId: string;
  runId: string;
  agentId?: string;
  occurredAt: string;
}>;

export function observeOpenClawLifecycleFrame(
  frame: EventFrame,
): OpenClawLifecycleSignal | null {
  if (frame.event === "sessions.changed") {
    return observeSessionsChangedFrame(frame);
  }
  if (frame.event !== "agent") return null;
  const parsed = agentEventPayloadSchema.safeParse(frame.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const occurredAt = new Date(
    typeof payload.ts === "number" && Number.isFinite(payload.ts)
      ? payload.ts
      : Date.now(),
  ).toISOString();
  const base = {
    sessionId: boundedIdentifier(
      payload.sessionId ?? payload.sessionKey ?? `run:${payload.runId}`,
    ),
    runId: boundedIdentifier(payload.runId),
    ...(payload.agentId
      ? { agentId: boundedIdentifier(payload.agentId) }
      : {}),
    occurredAt,
  };

  if (payload.stream === "lifecycle") {
    const phase = payload.data.phase;
    if (
      phase !== "start" &&
      phase !== "finishing" &&
      phase !== "end" &&
      phase !== "error"
    ) {
      return null;
    }
    const persistedStatus = readPersistedStatus(payload.data);
    return {
      ...base,
      signal: {
        event: "lifecycle",
        phase,
        ...(payload.data.aborted === true ? { aborted: true } : {}),
        ...(payload.data.yielded === true ? { yielded: true } : {}),
        ...(payload.data.paused === true ||
        payload.data.livenessState === "paused"
          ? { paused: true }
          : {}),
        ...(typeof payload.data.livenessState === "string"
          ? { livenessState: payload.data.livenessState }
          : {}),
        ...(persistedStatus ? { persistedStatus } : {}),
      },
    };
  }

  if (payload.stream === "approval") {
    const phase = payload.data.phase;
    const status = payload.data.status;
    if (
      (phase !== "requested" && phase !== "resolved") ||
      (status !== "pending" &&
        status !== "approved" &&
        status !== "denied" &&
        status !== "unavailable")
    ) {
      return null;
    }
    return {
      ...base,
      signal: { event: "approval", phase, status },
    };
  }

  return null;
}

function observeSessionsChangedFrame(
  frame: EventFrame,
): OpenClawLifecycleSignal | null {
  const parsed = sessionsChangedPayloadSchema.safeParse(frame.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const persistedStatus = payload.status ?? payload.session?.status;
  const waiting = payload.phase !== "start" && persistedStatus === "running";
  const occurredAt = new Date(
    typeof payload.ts === "number" && Number.isFinite(payload.ts)
      ? payload.ts
      : Date.now(),
  ).toISOString();

  return {
    sessionId: boundedIdentifier(
      payload.sessionId ?? payload.session?.sessionId ?? payload.sessionKey,
    ),
    runId: boundedIdentifier(payload.runId),
    ...(payload.agentId
      ? { agentId: boundedIdentifier(payload.agentId) }
      : {}),
    occurredAt,
    signal: {
      event: "lifecycle",
      phase: payload.phase,
      ...(payload.abortedLastRun === true ||
      payload.session?.abortedLastRun === true
        ? { aborted: true }
        : {}),
      ...(waiting ? { yielded: true, paused: true } : {}),
      ...(persistedStatus ? { persistedStatus } : {}),
    },
  };
}

function readPersistedStatus(
  data: Record<string, unknown>,
): "running" | "done" | "failed" | "killed" | "timeout" | undefined {
  const candidate = data.persistedStatus ?? data.status;
  if (
    candidate === "running" ||
    candidate === "done" ||
    candidate === "failed" ||
    candidate === "killed" ||
    candidate === "timeout"
  ) {
    return candidate;
  }
  return undefined;
}

function boundedIdentifier(value: string): string {
  if (value.length <= 200) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${value.slice(0, 167)}:${digest}`;
}
