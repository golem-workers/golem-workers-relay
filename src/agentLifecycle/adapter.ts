import {
  AGENT_LIFECYCLE_SCHEMA_VERSION,
  agentLifecycleEventSchema,
  classifyAgentLifecycleTransition,
  type AgentLifecycleEvent,
  type AgentLifecycleRunState,
  type AgentLifecycleStatus,
} from "./contract.js";

export type AgentLifecycleDiagnostics = Readonly<{
  nativeEvent?: string;
  nativeStatus?: string;
  reasonCode?: string;
}>;

export type AgentLifecycleObservation = Readonly<{
  status: AgentLifecycleStatus;
  diagnostics?: AgentLifecycleDiagnostics;
}>;

export interface ProviderLifecycleAdapter {
  readonly provider: string;
  observe(signal: unknown): AgentLifecycleObservation | null;
}

export type AgentLifecycleEventContext = Readonly<{
  serverId: string;
  agentId?: string;
  sessionId: string;
  runId: string;
  sourceGeneration: string;
  occurredAt: string;
  origin: "LIVE" | "RECONCILIATION";
}>;

type ScopedRunState = AgentLifecycleRunState & {
  sourceGeneration: string;
};

function scopeKey(
  adapter: ProviderLifecycleAdapter,
  context: AgentLifecycleEventContext,
): string {
  return [
    adapter.provider,
    context.serverId,
    context.agentId ?? "",
    context.sessionId,
  ].join("\u0000");
}

export class AgentLifecycleTransitionEncoder {
  private readonly currentByScope = new Map<string, ScopedRunState>();
  private readonly sequenceByGeneration = new Map<string, number>();
  private readonly terminalRuns = new Set<string>();

  seedActiveRun(
    adapter: ProviderLifecycleAdapter,
    context: AgentLifecycleEventContext,
    status: "RUNNING" | "WAITING",
  ): void {
    this.currentByScope.set(scopeKey(adapter, context), {
      runId: context.runId,
      status,
      sourceGeneration: context.sourceGeneration,
    });
  }

  observe(
    adapter: ProviderLifecycleAdapter,
    signal: unknown,
    context: AgentLifecycleEventContext,
  ): AgentLifecycleEvent | null {
    const observation = adapter.observe(signal);
    if (!observation || observation.status === "IDLE") {
      return null;
    }

    const terminalKey = [
      adapter.provider,
      context.serverId,
      context.agentId ?? "",
      context.runId,
      context.sourceGeneration,
    ].join("\u0000");
    if (this.terminalRuns.has(terminalKey)) {
      return null;
    }

    const key = scopeKey(adapter, context);
    const stored = this.currentByScope.get(key);
    const current =
      stored?.sourceGeneration === context.sourceGeneration
        ? { runId: stored.runId, status: stored.status }
        : null;
    const next: AgentLifecycleRunState = {
      runId: context.runId,
      status: observation.status,
    };
    const decision = classifyAgentLifecycleTransition(current, next);
    if (decision === "UNCHANGED" || decision === "REJECT_ILLEGAL") {
      return null;
    }

    const sequence =
      (this.sequenceByGeneration.get(context.sourceGeneration) ?? 0) + 1;
    const event = agentLifecycleEventSchema.parse({
      schemaVersion: AGENT_LIFECYCLE_SCHEMA_VERSION,
      eventType: "agent.lifecycle.changed",
      eventId: `lifecycle:${context.sourceGeneration}:${sequence}`,
      serverId: context.serverId,
      ...(context.agentId ? { agentId: context.agentId } : {}),
      provider: adapter.provider,
      sessionId: context.sessionId,
      runId: context.runId,
      sourceGeneration: context.sourceGeneration,
      sequence,
      status: observation.status,
      occurredAt: context.occurredAt,
      origin: context.origin,
      ...(observation.diagnostics
        ? { diagnostics: observation.diagnostics }
        : {}),
    });

    this.currentByScope.set(key, {
      ...next,
      sourceGeneration: context.sourceGeneration,
    });
    this.sequenceByGeneration.set(context.sourceGeneration, sequence);
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(observation.status)) {
      this.terminalRuns.add(terminalKey);
    }
    return event;
  }
}
