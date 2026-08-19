import { z } from "zod";

export const AGENT_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export const AGENT_LIFECYCLE_STATUSES = [
  "IDLE",
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const AGENT_LIFECYCLE_EVENT_STATUSES = [
  "RUNNING",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const agentLifecycleStatusSchema = z.enum(AGENT_LIFECYCLE_STATUSES);
export const agentLifecycleEventStatusSchema = z.enum(
  AGENT_LIFECYCLE_EVENT_STATUSES,
);

export type AgentLifecycleStatus = z.infer<typeof agentLifecycleStatusSchema>;
export type AgentLifecycleEventStatus = z.infer<
  typeof agentLifecycleEventStatusSchema
>;

const opaqueIdentifierSchema = z.string().trim().min(1).max(200);

export const agentLifecycleEventSchema = z
  .object({
    schemaVersion: z.literal(AGENT_LIFECYCLE_SCHEMA_VERSION),
    eventType: z.literal("agent.lifecycle.changed"),
    eventId: opaqueIdentifierSchema,
    serverId: opaqueIdentifierSchema,
    agentId: opaqueIdentifierSchema.optional(),
    provider: z
      .string()
      .regex(
        /^[a-z][a-z0-9_-]{0,63}$/,
        "provider must be a stable lowercase adapter id",
      ),
    sessionId: opaqueIdentifierSchema,
    runId: opaqueIdentifierSchema,
    sourceGeneration: opaqueIdentifierSchema,
    sequence: z.number().int().positive().safe(),
    status: agentLifecycleEventStatusSchema,
    occurredAt: z.string().datetime({ offset: true }),
    origin: z.enum(["LIVE", "RECONCILIATION"]),
    diagnostics: z
      .object({
        nativeEvent: z.string().trim().min(1).max(128).optional(),
        nativeStatus: z.string().trim().min(1).max(128).optional(),
        reasonCode: z.string().trim().min(1).max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AgentLifecycleEvent = z.infer<typeof agentLifecycleEventSchema>;

export type AgentLifecycleRunState = Readonly<{
  runId: string;
  status: AgentLifecycleEventStatus;
}>;

export type AgentLifecycleTransitionDecision =
  | "APPLY_NEW_RUN"
  | "APPLY_SAME_RUN"
  | "UNCHANGED"
  | "REJECT_ILLEGAL";

const sameRunTransitions: Record<
  AgentLifecycleEventStatus,
  ReadonlySet<AgentLifecycleEventStatus>
> = {
  RUNNING: new Set(["WAITING", "COMPLETED", "FAILED", "CANCELLED"]),
  WAITING: new Set(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
};

export function classifyAgentLifecycleTransition(
  current: AgentLifecycleRunState | null,
  next: AgentLifecycleRunState,
): AgentLifecycleTransitionDecision {
  if (!current) {
    return next.status === "RUNNING" || next.status === "WAITING"
      ? "APPLY_NEW_RUN"
      : "REJECT_ILLEGAL";
  }

  if (current.runId !== next.runId) {
    return next.status === "RUNNING" || next.status === "WAITING"
      ? "APPLY_NEW_RUN"
      : "REJECT_ILLEGAL";
  }

  if (current.status === next.status) {
    return "UNCHANGED";
  }

  return sameRunTransitions[current.status].has(next.status)
    ? "APPLY_SAME_RUN"
    : "REJECT_ILLEGAL";
}
