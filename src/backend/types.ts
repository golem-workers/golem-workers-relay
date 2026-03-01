import { z } from "zod";

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
    reply: z.unknown(),
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
]);
export type RelayInboundMessageRequest = z.infer<typeof relayInboundMessageRequestSchema>;

export const acceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

