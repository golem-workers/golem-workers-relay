import { z } from "zod";

import type {
  AgentLifecycleObservation,
  ProviderLifecycleAdapter,
} from "./adapter.js";

const openClawSignalSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("lifecycle"),
      phase: z.enum(["start", "finishing", "end", "error"]),
      aborted: z.boolean().optional(),
      yielded: z.boolean().optional(),
      paused: z.boolean().optional(),
      livenessState: z.string().max(128).optional(),
      persistedStatus: z
        .enum(["running", "done", "failed", "killed", "timeout"])
        .optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("approval"),
      phase: z.enum(["requested", "resolved"]),
      status: z.enum(["pending", "approved", "denied", "unavailable"]),
    })
    .strict(),
  z
    .object({
      event: z.literal("active_run"),
      hasActiveRun: z.boolean(),
      waiting: z.boolean().optional(),
    })
    .strict(),
]);

function lifecycleObservation(
  signal: Extract<z.infer<typeof openClawSignalSchema>, { event: "lifecycle" }>,
): AgentLifecycleObservation | null {
  const diagnostics = {
    nativeEvent: signal.event,
    nativeStatus: signal.phase,
    ...(signal.livenessState ? { reasonCode: signal.livenessState } : {}),
  };

  if (signal.phase === "start") {
    return { status: "RUNNING", diagnostics };
  }
  if (signal.phase === "finishing") {
    return null;
  }
  if (signal.yielded === true && signal.paused === true) {
    return {
      status: "WAITING",
      diagnostics: { ...diagnostics, reasonCode: "yielded_paused" },
    };
  }
  if (signal.aborted === true || signal.persistedStatus === "killed") {
    return { status: "CANCELLED", diagnostics };
  }
  if (
    signal.phase === "error" ||
    signal.persistedStatus === "failed" ||
    signal.persistedStatus === "timeout" ||
    signal.livenessState === "blocked" ||
    signal.livenessState === "abandoned"
  ) {
    return { status: "FAILED", diagnostics };
  }
  return { status: "COMPLETED", diagnostics };
}

export const openClawLifecycleAdapter: ProviderLifecycleAdapter = {
  provider: "openclaw",
  observe(signal: unknown): AgentLifecycleObservation | null {
    const parsed = openClawSignalSchema.safeParse(signal);
    if (!parsed.success) {
      return null;
    }

    const native = parsed.data;
    if (native.event === "lifecycle") {
      return lifecycleObservation(native);
    }
    if (native.event === "approval") {
      if (native.phase === "requested" && native.status === "pending") {
        return {
          status: "WAITING",
          diagnostics: {
            nativeEvent: native.event,
            nativeStatus: native.status,
            reasonCode: "approval",
          },
        };
      }
      if (native.phase === "resolved" && native.status === "approved") {
        return {
          status: "RUNNING",
          diagnostics: {
            nativeEvent: native.event,
            nativeStatus: native.status,
            reasonCode: "approval_resolved",
          },
        };
      }
      return null;
    }
    return {
      status: native.hasActiveRun
        ? native.waiting === true
          ? "WAITING"
          : "RUNNING"
        : "IDLE",
      diagnostics: {
        nativeEvent: native.event,
        nativeStatus: native.hasActiveRun ? "active" : "idle",
      },
    };
  },
};
