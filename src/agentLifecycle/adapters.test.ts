import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AgentLifecycleTransitionEncoder,
  type AgentLifecycleEventContext,
  type ProviderLifecycleAdapter,
} from "./adapter.js";
import { claudeCodeLifecycleAdapter } from "./claudeCodeAdapter.js";
import { codexLifecycleAdapter } from "./codexAdapter.js";
import type { AgentLifecycleStatus } from "./contract.js";
import { openClawLifecycleAdapter } from "./openclawAdapter.js";

type TraceFixture = Record<
  "codex" | "openclaw" | "claude_code",
  Record<"idle" | "success" | "failure" | "cancel", unknown[]>
>;

const traces = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/equivalent-traces.json", import.meta.url),
    "utf8",
  ),
) as TraceFixture;

const adapters = {
  codex: codexLifecycleAdapter,
  openclaw: openClawLifecycleAdapter,
  claude_code: claudeCodeLifecycleAdapter,
} as const;

function context(
  provider: keyof typeof adapters,
  generation: string,
): AgentLifecycleEventContext {
  return {
    serverId: "server-1",
    agentId: "main",
    sessionId: `session-${provider}`,
    runId: `run-${provider}`,
    sourceGeneration: generation,
    occurredAt: "2026-08-19T09:30:00.000Z",
    origin: "LIVE",
  };
}

function encodeTrace(
  provider: keyof typeof adapters,
  name: keyof TraceFixture["codex"],
  generation: string,
): AgentLifecycleStatus[] {
  const encoder = new AgentLifecycleTransitionEncoder();
  return traces[provider][name].flatMap((signal) => {
    const event = encoder.observe(
      adapters[provider],
      signal,
      context(provider, generation),
    );
    return event ? [event.status] : [];
  });
}

describe("provider-neutral lifecycle adapters", () => {
  it("maps equivalent success traces to identical canonical transitions", () => {
    for (const provider of Object.keys(adapters) as Array<
      keyof typeof adapters
    >) {
      expect(
        encodeTrace(provider, "success", `generation-${provider}`),
        provider,
      ).toEqual(["RUNNING", "WAITING", "RUNNING", "COMPLETED"]);
    }
  });

  it("maps equivalent failure and cancellation outcomes", () => {
    for (const provider of Object.keys(adapters) as Array<
      keyof typeof adapters
    >) {
      expect(
        encodeTrace(provider, "failure", `failure-${provider}`),
        provider,
      ).toEqual(["RUNNING", "FAILED"]);
      expect(
        encodeTrace(provider, "cancel", `cancel-${provider}`),
        provider,
      ).toEqual(["RUNNING", "CANCELLED"]);
    }
  });

  it("emits no lifecycle traffic for idle or unrecognized provider chatter", () => {
    for (const provider of Object.keys(adapters) as Array<
      keyof typeof adapters
    >) {
      expect(
        encodeTrace(provider, "idle", `idle-${provider}`),
        provider,
      ).toEqual([]);
      const encoder = new AgentLifecycleTransitionEncoder();
      expect(
        encoder.observe(
          adapters[provider],
          { event: "token/delta", text: "not lifecycle" },
          context(provider, `chatter-${provider}`),
        ),
      ).toBeNull();
    }
  });

  it("suppresses unchanged states and keeps sequence monotonic per generation", () => {
    const encoder = new AgentLifecycleTransitionEncoder();
    const ctx = context("codex", "generation-shared");
    const first = encoder.observe(
      codexLifecycleAdapter,
      { event: "turn/started", status: "inProgress" },
      ctx,
    );
    const duplicate = encoder.observe(
      codexLifecycleAdapter,
      { event: "turn/started", status: "inProgress" },
      ctx,
    );
    const waiting = encoder.observe(
      codexLifecycleAdapter,
      {
        event: "thread/status/changed",
        status: "active",
        activeFlags: ["waitingOnUserInput"],
      },
      ctx,
    );

    expect(first?.sequence).toBe(1);
    expect(duplicate).toBeNull();
    expect(waiting?.sequence).toBe(2);
    expect(waiting?.diagnostics?.reasonCode).toBe("waitingOnUserInput");
    expect(waiting).not.toHaveProperty("activeFlags");
  });

  it("does not let late provider events rewrite a terminal run", () => {
    const encoder = new AgentLifecycleTransitionEncoder();
    const ctx = context("openclaw", "generation-terminal");
    expect(
      encoder.observe(
        openClawLifecycleAdapter,
        { event: "lifecycle", phase: "start" },
        ctx,
      )?.status,
    ).toBe("RUNNING");
    expect(
      encoder.observe(
        openClawLifecycleAdapter,
        { event: "lifecycle", phase: "end" },
        ctx,
      )?.status,
    ).toBe("COMPLETED");
    expect(
      encoder.observe(
        openClawLifecycleAdapter,
        { event: "approval", phase: "requested", status: "pending" },
        ctx,
      ),
    ).toBeNull();
    expect(
      encoder.observe(
        openClawLifecycleAdapter,
        { event: "lifecycle", phase: "end" },
        { ...ctx, sessionId: "session-alias" },
      ),
    ).toBeNull();
  });

  it("supports a future adapter without expanding the canonical enum", () => {
    const futureAdapter: ProviderLifecycleAdapter = {
      provider: "future_agent",
      observe(signal: unknown) {
        return signal === "begin" ? { status: "RUNNING" as const } : null;
      },
    };
    const encoder = new AgentLifecycleTransitionEncoder();
    const event = encoder.observe(futureAdapter, "begin", {
      ...context("codex", "future-generation"),
      sessionId: "future-session",
      runId: "future-run",
    });

    expect(event).toMatchObject({
      provider: "future_agent",
      status: "RUNNING",
      sequence: 1,
    });
  });
});
