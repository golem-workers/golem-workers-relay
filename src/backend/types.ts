import { z } from "zod";

const relayMediaSchema = z.discriminatedUnion("type", [
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
  z.object({
    type: z.literal("image"),
    dataB64: z.string().min(1),
    contentType: z.string().min(1),
    fileName: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("video"),
    dataB64: z.string().min(1),
    contentType: z.string().min(1),
    fileName: z.string().min(1).optional(),
  }),
]);

const replyMediaFileSchema = z
  .object({
    path: z.string().min(1).optional(),
    fileName: z.string().min(1),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
    dataB64: z.string().min(1).optional(),
    dataPrefix: z.string().min(1).optional(),
    dataLength: z.number().int().positive().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

const relayReplySchema = z
  .object({
    message: z.unknown().optional(),
    runId: z.string().min(1).optional(),
    media: z.array(replyMediaFileSchema).optional(),
    openclawEvents: z.array(z.unknown()).optional(),
  })
  .passthrough();

const chatTaskInputSchema = z
  .object({
    kind: z.literal("chat"),
    sessionKey: z.string().min(1),
    messageText: z.string(),
    media: z.array(relayMediaSchema).optional(),
    context: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    const hasText = value.messageText.trim().length > 0;
    const hasMedia = Array.isArray(value.media) && value.media.length > 0;
    if (hasText || hasMedia) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "messageText or media is required",
      path: ["messageText"],
    });
  });

const handshakeTaskInputSchema = z.object({
  kind: z.literal("handshake"),
  nonce: z.string().min(1),
});

const sessionNewTaskInputSchema = z.object({
  kind: z.literal("session_new"),
});

export const taskInputSchema = z.discriminatedUnion("kind", [
  chatTaskInputSchema,
  handshakeTaskInputSchema,
  sessionNewTaskInputSchema,
]);

export type TaskInput = z.infer<typeof taskInputSchema>;

export const inboundPushMessageSchema = z.object({
  messageId: z.string().min(1),
  sentAtMs: z.number().int().nonnegative().optional(),
  input: taskInputSchema,
});
export type InboundPushMessage = z.infer<typeof inboundPushMessageSchema>;

export const relayInboundMessageRequestSchema = z.discriminatedUnion("outcome", [
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1).optional(),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("reply"),
    reply: relayReplySchema,
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1).optional(),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("no_reply"),
    noReply: z.unknown().optional(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1).optional(),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("error"),
    error: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
  z.object({
    relayInstanceId: z.string().min(1),
    relayMessageId: z.string().min(1).optional(),
    finishedAtMs: z.number().int().nonnegative(),
    outcome: z.literal("technical"),
    technical: z.unknown(),
    openclawMeta: z.unknown().optional(),
  }),
]);
export type RelayInboundMessageRequest = z.infer<typeof relayInboundMessageRequestSchema>;

export const relayOpenclawStatusRequestSchema = z.object({
  relayInstanceId: z.string().min(1),
  observedAtMs: z.number().int().nonnegative(),
  status: z.enum(["CONNECTED", "DISCONNECTED"]),
  reason: z.string().min(1).max(1000).optional(),
});
export type RelayOpenclawStatusRequest = z.infer<typeof relayOpenclawStatusRequestSchema>;

export const acceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

