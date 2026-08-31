import { z } from "zod";

export type AgentLifecycleActiveRun = Readonly<{
  provider: string;
  agentId?: string;
  sessionId: string;
  runId: string;
  status: "RUNNING" | "WAITING";
}>;

export type AgentLifecycleCorrection =
  | Readonly<{
      kind: "ACTIVE";
      run: AgentLifecycleActiveRun;
    }>
  | Readonly<{
      kind: "DISAPPEARED";
      run: AgentLifecycleActiveRun;
    }>;

const sessionsPayloadSchema = z
  .object({
    sessions: z.array(
      z
        .object({
          key: z.string().min(1),
          sessionId: z.string().min(1).optional(),
          agentId: z.string().min(1).optional(),
          hasActiveRun: z.boolean().optional(),
          activeRunIds: z.array(z.string().min(1)).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type OpenClawActiveRunsDiagnostics = Readonly<{
  payloadValid: boolean;
  sessionCount: number;
  activeSessionCount: number;
  activeRunIdCount: number;
  sessions: ReadonlyArray<
    Readonly<{
      key: string;
      sessionId: string | null;
      agentId: string | null;
      hasActiveRun: boolean | null;
      activeRunIds: readonly string[];
      status: string | null;
      updatedAt: string | null;
      lastActivityAt: string | null;
      sourceGeneration: string | null;
    }>
  >;
}>;

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function describeOpenClawActiveRunsPayload(
  payload: unknown,
): OpenClawActiveRunsDiagnostics {
  const parsed = sessionsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      payloadValid: false,
      sessionCount: 0,
      activeSessionCount: 0,
      activeRunIdCount: 0,
      sessions: [],
    };
  }
  const sessions = parsed.data.sessions.map((session) => {
    const record = session as Record<string, unknown>;
    return {
      key: session.key,
      sessionId: session.sessionId ?? null,
      agentId: session.agentId ?? null,
      hasActiveRun:
        typeof session.hasActiveRun === "boolean" ? session.hasActiveRun : null,
      activeRunIds: session.activeRunIds ?? [],
      status: readOptionalString(record, "status"),
      updatedAt: readOptionalString(record, "updatedAt"),
      lastActivityAt: readOptionalString(record, "lastActivityAt"),
      sourceGeneration: readOptionalString(record, "sourceGeneration"),
    };
  });
  return {
    payloadValid: true,
    sessionCount: sessions.length,
    activeSessionCount: sessions.filter((session) => session.hasActiveRun === true).length,
    activeRunIdCount: sessions.reduce(
      (total, session) => total + session.activeRunIds.length,
      0,
    ),
    sessions,
  };
}

export function readOpenClawActiveRuns(
  payload: unknown,
): AgentLifecycleActiveRun[] {
  const parsed = sessionsPayloadSchema.safeParse(payload);
  if (!parsed.success) return [];
  const byRunId = new Map<string, AgentLifecycleActiveRun>();
  for (const session of parsed.data.sessions) {
    if (session.hasActiveRun !== true) continue;
    for (const runId of session.activeRunIds ?? []) {
      byRunId.set(runId, {
        provider: "openclaw",
        ...(session.agentId ? { agentId: session.agentId } : {}),
        sessionId: session.sessionId ?? session.key,
        runId,
        status: "RUNNING",
      });
    }
  }
  return [...byRunId.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId),
  );
}

export function planAgentLifecycleReconciliation(input: {
  checkpoint: AgentLifecycleActiveRun[];
  observed: AgentLifecycleActiveRun[];
}): AgentLifecycleCorrection[] {
  const checkpointByRun = new Map(
    input.checkpoint.map((run) => [run.runId, run] as const),
  );
  const observedByRun = new Map(
    input.observed.map((run) => [run.runId, run] as const),
  );
  const corrections: AgentLifecycleCorrection[] = [];

  for (const observed of observedByRun.values()) {
    const checkpoint = checkpointByRun.get(observed.runId);
    corrections.push({
      kind: "ACTIVE",
      run: checkpoint ? { ...observed, status: checkpoint.status } : observed,
    });
  }
  for (const checkpoint of checkpointByRun.values()) {
    if (!observedByRun.has(checkpoint.runId)) {
      corrections.push({ kind: "DISAPPEARED", run: checkpoint });
    }
  }
  return corrections;
}
