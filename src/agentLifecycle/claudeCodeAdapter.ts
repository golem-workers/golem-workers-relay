import { z } from "zod";

import type {
  AgentLifecycleObservation,
  ProviderLifecycleAdapter,
} from "./adapter.js";

const claudeCodeSignalSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("hook"),
      hook: z.enum([
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "Elicitation",
        "Stop",
        "StopFailure",
      ]),
    })
    .strict(),
  z
    .object({
      event: z.literal("sdk"),
      kind: z.enum(["query_accepted", "result", "interrupt"]),
      subtype: z.string().max(128).optional(),
      terminalReason: z.string().max(128).optional(),
    })
    .strict(),
  z
    .object({
      event: z.literal("active_query"),
      active: z.boolean(),
      waiting: z.boolean().optional(),
    })
    .strict(),
]);

function sdkObservation(
  signal: Extract<z.infer<typeof claudeCodeSignalSchema>, { event: "sdk" }>,
): AgentLifecycleObservation {
  const diagnostics = {
    nativeEvent: signal.event,
    nativeStatus: signal.kind,
    ...(signal.terminalReason ? { reasonCode: signal.terminalReason } : {}),
  };

  if (signal.kind === "query_accepted") {
    return { status: "RUNNING", diagnostics };
  }
  if (
    signal.kind === "interrupt" ||
    signal.terminalReason === "aborted_streaming" ||
    signal.terminalReason === "aborted_tools"
  ) {
    return { status: "CANCELLED", diagnostics };
  }
  if (signal.terminalReason === "tool_deferred") {
    return { status: "WAITING", diagnostics };
  }
  if (signal.subtype?.startsWith("error_") === true) {
    return { status: "FAILED", diagnostics };
  }
  return { status: "COMPLETED", diagnostics };
}

export const claudeCodeLifecycleAdapter: ProviderLifecycleAdapter = {
  provider: "claude_code",
  observe(signal: unknown): AgentLifecycleObservation | null {
    const parsed = claudeCodeSignalSchema.safeParse(signal);
    if (!parsed.success) {
      return null;
    }

    const native = parsed.data;
    if (native.event === "sdk") {
      return sdkObservation(native);
    }
    if (native.event === "active_query") {
      return {
        status: native.active
          ? native.waiting === true
            ? "WAITING"
            : "RUNNING"
          : "IDLE",
        diagnostics: {
          nativeEvent: native.event,
          nativeStatus: native.active ? "active" : "idle",
        },
      };
    }

    const diagnostics = {
      nativeEvent: native.event,
      nativeStatus: native.hook,
    };
    switch (native.hook) {
      case "UserPromptSubmit":
      case "PreToolUse":
        return { status: "RUNNING", diagnostics };
      case "PermissionRequest":
      case "Elicitation":
        return { status: "WAITING", diagnostics };
      case "Stop":
        return { status: "COMPLETED", diagnostics };
      case "StopFailure":
        return { status: "FAILED", diagnostics };
      default:
        return native.hook satisfies never;
    }
  },
};
