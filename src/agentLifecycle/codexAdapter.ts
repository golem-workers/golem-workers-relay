import { z } from "zod";

import type {
  AgentLifecycleObservation,
  ProviderLifecycleAdapter,
} from "./adapter.js";

const codexSignalSchema = z.union([
  z
    .object({
      event: z.literal("turn/started"),
      status: z.literal("inProgress"),
    })
    .strict(),
  z
    .object({
      event: z.literal("turn/completed"),
      status: z.enum(["completed", "failed", "interrupted"]),
    })
    .strict(),
  z
    .object({
      event: z.literal("thread/status/changed"),
      status: z.literal("active"),
      activeFlags: z.array(z.enum(["waitingOnApproval", "waitingOnUserInput"])),
    })
    .strict(),
  z
    .object({
      event: z.literal("thread/status/changed"),
      status: z.literal("idle"),
    })
    .strict(),
]);

export const codexLifecycleAdapter: ProviderLifecycleAdapter = {
  provider: "codex",
  observe(signal: unknown): AgentLifecycleObservation | null {
    const parsed = codexSignalSchema.safeParse(signal);
    if (!parsed.success) {
      return null;
    }

    const native = parsed.data;
    if (native.event === "turn/started") {
      return {
        status: "RUNNING",
        diagnostics: { nativeEvent: native.event, nativeStatus: native.status },
      };
    }
    if (native.event === "turn/completed") {
      const status =
        native.status === "completed"
          ? "COMPLETED"
          : native.status === "interrupted"
            ? "CANCELLED"
            : "FAILED";
      return {
        status,
        diagnostics: { nativeEvent: native.event, nativeStatus: native.status },
      };
    }
    if (native.status === "idle") {
      return {
        status: "IDLE",
        diagnostics: { nativeEvent: native.event, nativeStatus: native.status },
      };
    }
    if (native.activeFlags.length > 0) {
      return {
        status: "WAITING",
        diagnostics: {
          nativeEvent: native.event,
          nativeStatus: native.status,
          reasonCode: native.activeFlags.join("+"),
        },
      };
    }
    return {
      status: "RUNNING",
      diagnostics: { nativeEvent: native.event, nativeStatus: native.status },
    };
  },
};
