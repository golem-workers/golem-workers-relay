import { z } from "zod";

/** Mirrors golem-workers-openclaw-channel-plugin control-plane hello (relay side). */

export const relayTransportSchema = z.object({
  provider: z.string(),
  providerVersion: z.string().optional(),
});

export const capabilityMapSchema = z.record(z.string(), z.boolean());

const TELEGRAM_CORE_CAPABILITIES = {
  messageSend: true,
  mediaSend: true,
  inboundMessages: true,
  replyTo: true,
  threadRouting: true,
} as const;

const TELEGRAM_OPTIONAL_CAPABILITIES = {
  messageEdit: true,
  messageDelete: true,
  reactions: true,
  typing: true,
  polls: true,
  pinning: true,
  fileDownloads: true,
} as const;

const TELEGRAM_PROVIDER_CAPABILITIES = {
  "telegram.inlineButtons": true,
  "telegram.forumTopics": true,
  "telegram.callbackAnswer": true,
} as const;

const TELEGRAM_TARGET_CAPABILITIES = {
  dm: {
    messageEdit: true,
    messageDelete: true,
    reactions: true,
    typing: true,
    polls: true,
    pinning: true,
    fileDownloads: true,
    "telegram.inlineButtons": true,
  },
  group: {
    messageEdit: true,
    messageDelete: true,
    reactions: true,
    typing: true,
    polls: true,
    pinning: true,
    fileDownloads: true,
    "telegram.inlineButtons": true,
  },
  topic: {
    messageEdit: true,
    messageDelete: true,
    reactions: true,
    typing: true,
    polls: true,
    pinning: true,
    fileDownloads: true,
    "telegram.inlineButtons": true,
    "telegram.forumTopics": true,
  },
} as const;

export const helloRequestSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  role: z.literal("openclaw-channel-plugin"),
  channelId: z.string(),
  instanceId: z.string(),
  accountId: z.string(),
  supports: z.object({
    asyncLifecycle: z.boolean(),
    fileDownloadRequests: z.boolean(),
    capabilityNegotiation: z.boolean(),
    accountScopedStatus: z.boolean(),
  }),
  requestedCapabilities: z.object({
    core: z.array(z.string()),
    optional: z.array(z.string()),
  }),
});

export const transportActionSchema = z.object({
  actionId: z.string(),
  kind: z.enum([
    "message.send",
    "message.edit",
    "message.delete",
    "reaction.set",
    "typing.set",
    "poll.send",
    "message.pin",
    "message.unpin",
    "topic.create",
    "topic.edit",
    "topic.close",
    "callback.answer",
    "file.download.request",
  ]),
  idempotencyKey: z.string(),
  accountId: z.string(),
  targetScope: z.enum(["dm", "group", "topic"]),
  transportTarget: z.record(z.string(), z.string()),
  conversation: z.object({
    transportConversationId: z.string(),
    baseConversationId: z.string().nullable().optional(),
    parentConversationCandidates: z.array(z.string()).optional(),
  }),
  thread: z
    .object({
      threadId: z.string().nullable().optional(),
    })
    .optional(),
  reply: z
    .object({
      replyToTransportMessageId: z.string().nullable().optional(),
    })
    .optional(),
  payload: z.record(z.string(), z.unknown()),
  openclawContext: z
    .object({
      sessionKey: z.string().optional(),
      runId: z.string().optional(),
    })
    .optional(),
});

export const transportActionRequestSchema = z.object({
  type: z.literal("request"),
  requestType: z.literal("transport.action"),
  requestId: z.string(),
  action: transportActionSchema,
});

export function buildHelloResponse(input: {
  relayInstanceId: string;
  accountId: string;
  dataPlane: { uploadBaseUrl: string; downloadBaseUrl: string };
}): Record<string, unknown> {
  return {
    type: "hello",
    protocolVersion: 1,
    role: "local-relay",
    relayInstanceId: input.relayInstanceId,
    accountId: input.accountId,
    transport: { provider: "telegram", providerVersion: "bot-api-compatible" },
    coreCapabilities: TELEGRAM_CORE_CAPABILITIES,
    optionalCapabilities: TELEGRAM_OPTIONAL_CAPABILITIES,
    providerCapabilities: TELEGRAM_PROVIDER_CAPABILITIES,
    targetCapabilities: TELEGRAM_TARGET_CAPABILITIES,
    limits: {},
    dataPlane: input.dataPlane,
  };
}

export function buildActionAccepted(input: { requestId: string; actionId: string }): Record<string, unknown> {
  return {
    type: "event",
    eventType: "transport.action.accepted",
    payload: {
      requestId: input.requestId,
      actionId: input.actionId,
    },
  };
}

export function buildActionCompleted(input: {
  requestId: string;
  actionId: string;
  result: {
    transportMessageId?: string;
    conversationId?: string;
    threadId?: string;
    uploadUrl?: string;
    downloadUrl?: string;
    token?: string;
  };
}): Record<string, unknown> {
  return {
    type: "event",
    eventType: "transport.action.completed",
    payload: {
      requestId: input.requestId,
      actionId: input.actionId,
      result: input.result,
    },
  };
}

export function buildProtocolError(input: { code: string; message: string }): Record<string, unknown> {
  return {
    type: "event",
    eventType: "transport.protocol.error",
    payload: {
      code: input.code,
      message: input.message,
    },
  };
}
