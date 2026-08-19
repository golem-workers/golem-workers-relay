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
