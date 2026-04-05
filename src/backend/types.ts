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

const replyArtifactSchema = z
  .object({
    path: z.string().min(1),
    fileName: z.string().min(1),
    kind: z.enum(["image", "video", "audio", "file"]),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
  })
  .strict();

const relayReplySchema = z
  .object({
    message: z.unknown().optional(),
    runId: z.string().min(1).optional(),
    artifacts: z.array(replyArtifactSchema).optional(),
    media: z.array(replyMediaFileSchema).optional(),
    openclawEvents: z.array(z.unknown()).optional(),
  })
  .passthrough();

const relayReplyChunkSchema = z
  .object({
    text: z.string().min(1),
    runId: z.string().min(1),
    seq: z.number().int().min(0),
  })
  .strict();

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

const relayTransportEventSchema = z.object({
  type: z.literal("event"),
  eventType: z.enum([
    "transport.message.received",
    "transport.message.edited",
    "transport.message.deleted",
    "transport.reaction.updated",
    "transport.callback.received",
    "transport.poll.updated",
    "transport.topic.updated",
    "transport.delivery.receipt",
    "transport.typing.updated",
    "transport.capabilities.updated",
    "transport.account.connecting",
    "transport.account.ready",
    "transport.account.degraded",
    "transport.account.disconnected",
    "transport.account.status",
    "transport.replay.gap",
    "transport.protocol.error",
  ]),
  payload: z.record(z.string(), z.unknown()),
});

const transportEventTaskInputSchema = z.object({
  kind: z.literal("transport_event"),
  event: relayTransportEventSchema,
});

export const taskInputSchema = z.discriminatedUnion("kind", [
  chatTaskInputSchema,
  handshakeTaskInputSchema,
  sessionNewTaskInputSchema,
  transportEventTaskInputSchema,
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
    outcome: z.literal("reply_chunk"),
    replyChunk: relayReplyChunkSchema,
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

const relayDeliveryReportSchema = z
  .object({
    modeEffective: z.enum(["legacy_push_v1", "relay_channel_v2"]).optional(),
    legacyPushReady: z.boolean().nullable().optional(),
    relayChannelReady: z.boolean().nullable().optional(),
    relayChannelConnected: z.boolean().nullable().optional(),
    relayChannelLastError: z.string().nullable().optional(),
  })
  .strict();

export const relayOpenclawStatusRequestSchema = z.object({
  relayInstanceId: z.string().min(1),
  observedAtMs: z.number().int().nonnegative(),
  status: z.enum(["CONNECTED", "DISCONNECTED"]),
  reason: z.string().min(1).max(1000).optional(),
  delivery: relayDeliveryReportSchema.optional(),
});
export type RelayOpenclawStatusRequest = z.infer<typeof relayOpenclawStatusRequestSchema>;

export const acceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

export const whatsAppPersonalTransportSendRequestSchema = z.object({
  action: z.object({
    transportTarget: z.object({
      channel: z.literal("whatsapp_personal"),
      chatId: z.string().min(1),
    }),
    reply: z
      .object({
        replyToTransportMessageId: z.string().min(1).nullable().optional(),
      })
      .optional(),
    payload: z
      .object({
        text: z.string().optional(),
        media: z
          .object({
            type: z.enum(["audio", "file", "image", "video"]),
            dataB64: z.string().min(1),
            contentType: z.string().min(1),
            fileName: z.string().min(1).optional(),
            asVoice: z.boolean().optional(),
          })
          .optional(),
      })
      .strict(),
  }),
});
export type WhatsAppPersonalTransportSendRequest = z.infer<typeof whatsAppPersonalTransportSendRequestSchema>;

export const whatsAppPersonalTransportSendResponseSchema = z.object({
  transportMessageId: z.string().min(1),
});
export type WhatsAppPersonalTransportSendResponse = z.infer<typeof whatsAppPersonalTransportSendResponseSchema>;

export const relayTelegramMessageCorrelationRequestSchema = z.object({
  chatId: z.string().min(1),
  transportMessageId: z.string().min(1),
  conversationHandle: z.string().min(1).optional(),
  threadHandle: z.string().min(1).nullable().optional(),
  targetScope: z.enum(["dm", "group", "topic"]).optional(),
  threadId: z.string().min(1).nullable().optional(),
});
export type RelayTelegramMessageCorrelationRequest = z.infer<
  typeof relayTelegramMessageCorrelationRequestSchema
>;

export const relayTelegramPollCorrelationRequestSchema = z.object({
  pollId: z.string().min(1),
  chatId: z.string().min(1),
  transportMessageId: z.string().min(1),
  conversationHandle: z.string().min(1).optional(),
  threadHandle: z.string().min(1).nullable().optional(),
  targetScope: z.enum(["dm", "group", "topic"]).optional(),
  threadId: z.string().min(1).nullable().optional(),
});
export type RelayTelegramPollCorrelationRequest = z.infer<
  typeof relayTelegramPollCorrelationRequestSchema
>;

