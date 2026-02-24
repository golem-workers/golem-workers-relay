import { z } from "zod";

export const pullRequestSchema = z.object({
  relayInstanceId: z.string().min(1),
  maxTasks: z.number().int().min(1).max(20),
  waitSeconds: z.number().int().min(0).max(100_000_000),
});

const chatTaskInputSchema = z.object({
  kind: z.literal("chat"),
  sessionKey: z.string().min(1),
  messageText: z.string().min(1),
  media: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("audio"),
          dataB64: z.string().min(1),
          contentType: z.string().min(1),
          fileName: z.string().min(1).optional(),
        }),
        z.object({
          type: z.literal("file"),
          dataB64: z.string().min(1),
          contentType: z.string().min(1),
          fileName: z.string().min(1).optional(),
        }),
      ])
    )
    .optional(),
  context: z.unknown().optional(),
});

const handshakeTaskInputSchema = z.object({
  kind: z.literal("handshake"),
  nonce: z.string().min(1),
});

const sessionNewTaskInputSchema = z.object({
  kind: z.literal("session_new"),
});

export const taskInputSchema = z.preprocess((value) => {
  // Back-compat: older backends send `{ sessionKey, messageText }` without a `kind`.
  if (value && typeof value === "object" && (value as { constructor?: unknown }).constructor === Object) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.kind !== "string" && typeof obj.sessionKey === "string" && typeof obj.messageText === "string") {
      return { kind: "chat", ...obj };
    }
  }
  return value;
}, z.discriminatedUnion("kind", [chatTaskInputSchema, handshakeTaskInputSchema, sessionNewTaskInputSchema]));

export const leasedTaskSchema = z.object({
  taskId: z.string().min(1),
  attempt: z.number().int().min(1),
  leaseId: z.string().min(1),
  leaseExpiresAt: z.string().min(1),
  input: taskInputSchema,
});

export const pullResponseSchema = z.object({
  tasks: z.array(leasedTaskSchema),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;
export type LeasedTask = z.infer<typeof leasedTaskSchema>;
export type PullResponse = z.infer<typeof pullResponseSchema>;
export type TaskInput = z.infer<typeof taskInputSchema>;

export const inboundPushMessageSchema = z.object({
  messageId: z.string().min(1),
  sentAtMs: z.number().int().nonnegative().optional(),
  input: taskInputSchema,
});
export type InboundPushMessage = z.infer<typeof inboundPushMessageSchema>;

export const taskResultRequestSchema = z.discriminatedUnion("outcome", [
  z.object({
    relayInstanceId: z.string().min(1),
    attempt: z.number().int().min(1),
    leaseId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("reply"),
    reply: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    attempt: z.number().int().min(1),
    leaseId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("no_reply"),
    noReply: z.unknown().optional(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    attempt: z.number().int().min(1),
    leaseId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("error"),
    error: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
]);

export type TaskResultRequest = z.infer<typeof taskResultRequestSchema>;

export const relayInboundMessageRequestSchema = z.discriminatedUnion("outcome", [
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("reply"),
    reply: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("no_reply"),
    noReply: z.unknown().optional(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("error"),
    error: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
]);
export type RelayInboundMessageRequest = z.infer<typeof relayInboundMessageRequestSchema>;

export const acceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

