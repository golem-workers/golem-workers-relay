import { z } from "zod";

/** Mirrors golem-workers-openclaw-channel-plugin control-plane hello (relay side). */

export const relayTransportSchema = z.object({
  provider: z.string(),
  providerVersion: z.string().optional(),
});

export const capabilityMapSchema = z.record(z.string(), z.boolean());

type ProviderProfile = {
  transport: {
    provider: string;
    providerVersion?: string;
  };
  coreCapabilities: Record<string, boolean>;
  optionalCapabilities: Record<string, boolean>;
  providerCapabilities: Record<string, boolean>;
  providerFeatures?: Record<string, unknown>;
  targetCapabilities?: Record<string, Record<string, boolean>>;
  limits: {
    maxUploadBytes?: number;
    maxCaptionBytes?: number;
    maxPollOptions?: number;
  };
};

const RELAY_PROVIDER_PROFILES = {
  telegram: {
    transport: { provider: "telegram", providerVersion: "bot-api-compatible" },
    coreCapabilities: {
      messageSend: true,
      mediaSend: true,
      inboundMessages: true,
      replyTo: true,
      threadRouting: true,
    },
    optionalCapabilities: {
      reactions: true,
      typing: true,
      pinning: true,
      fileDownloads: true,
    },
    providerCapabilities: {},
    providerFeatures: {},
    targetCapabilities: {
      dm: {
        reactions: true,
        typing: true,
        pinning: true,
        fileDownloads: true,
      },
      group: {
        reactions: true,
        typing: true,
        pinning: true,
        fileDownloads: true,
      },
    },
    limits: {},
  },
  whatsapp_personal: {
    transport: { provider: "whatsapp_personal", providerVersion: "relay-backend-bridge" },
    coreCapabilities: {
      messageSend: true,
      mediaSend: true,
      replyTo: true,
    },
    optionalCapabilities: {},
    providerCapabilities: {
      "whatsappPersonal.mediaBase64Upload": true,
    },
    providerFeatures: {
      "media.base64Upload": true,
    },
    limits: {},
  },
} as const satisfies Record<string, ProviderProfile>;

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
    "reaction.set",
    "typing.set",
    "message.pin",
    "message.unpin",
    "file.download.request",
  ]),
  idempotencyKey: z.string(),
  accountId: z.string(),
  targetScope: z.enum(["dm", "group", "topic"]).optional(),
  transportTarget: z.record(z.string(), z.string()),
  conversation: z.object({
    handle: z.string().optional(),
    transportConversationId: z.string().optional(),
    baseConversationId: z.string().nullable().optional(),
    parentConversationCandidates: z.array(z.string()).optional(),
  }),
  thread: z
    .object({
      handle: z.string().nullable().optional(),
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
  requestedCapabilities: {
    core: string[];
    optional: string[];
  };
}): Record<string, unknown> {
  const providerProfiles = Object.fromEntries(
    Object.entries(RELAY_PROVIDER_PROFILES).map(([providerKey, profile]) => [
      providerKey,
      filterProviderProfile(profile, input.requestedCapabilities),
    ])
  );
  const aggregate = buildAggregateProfile(Object.values(providerProfiles));
  return {
    type: "hello",
    protocolVersion: 1,
    role: "local-relay",
    relayInstanceId: input.relayInstanceId,
    accountId: input.accountId,
    transport: aggregate.transport,
    coreCapabilities: aggregate.coreCapabilities,
    optionalCapabilities: aggregate.optionalCapabilities,
    providerCapabilities: aggregate.providerCapabilities,
    providerFeatures: aggregate.providerFeatures,
    providerProfiles,
    targetCapabilities: aggregate.targetCapabilities,
    limits: aggregate.limits,
    dataPlane: input.dataPlane,
  };
}

function filterProviderProfile(
  profile: ProviderProfile,
  requestedCapabilities: {
    core: string[];
    optional: string[];
  }
): ProviderProfile {
  const requestedCore = new Set(requestedCapabilities.core);
  const requestedOptional = new Set(requestedCapabilities.optional);
  const requestedNames = new Set([...requestedCapabilities.core, ...requestedCapabilities.optional]);

  return {
    transport: profile.transport,
    coreCapabilities: filterCapabilityMap(profile.coreCapabilities, requestedCore),
    optionalCapabilities: filterCapabilityMap(profile.optionalCapabilities, requestedOptional),
    providerCapabilities: filterCapabilityMap(profile.providerCapabilities, requestedNames),
    providerFeatures: profile.providerFeatures,
    targetCapabilities: profile.targetCapabilities,
    limits: profile.limits,
  };
}

function filterCapabilityMap(
  source: Record<string, boolean>,
  requested: ReadonlySet<string>
): Record<string, boolean> {
  if (requested.size === 0) {
    return { ...source };
  }
  const filtered: Record<string, boolean> = {};
  for (const key of requested) {
    if (key in source) {
      filtered[key] = source[key] === true;
    }
  }
  return filtered;
}

function buildAggregateProfile(profiles: ProviderProfile[]): ProviderProfile {
  return profiles.reduce<ProviderProfile>(
    (acc, profile) => ({
      transport: { provider: "multi", providerVersion: "provider-profiles-v1" },
      coreCapabilities: mergeCapabilityMaps(acc.coreCapabilities, profile.coreCapabilities),
      optionalCapabilities: mergeCapabilityMaps(acc.optionalCapabilities, profile.optionalCapabilities),
      providerCapabilities: mergeCapabilityMaps(acc.providerCapabilities, profile.providerCapabilities),
      providerFeatures: {
        ...(acc.providerFeatures ?? {}),
        ...(profile.providerFeatures ?? {}),
      },
      targetCapabilities: mergeTargetCapabilities(acc.targetCapabilities, profile.targetCapabilities),
      limits: {
        ...acc.limits,
        ...profile.limits,
      },
    }),
    {
      transport: { provider: "multi", providerVersion: "provider-profiles-v1" },
      coreCapabilities: {},
      optionalCapabilities: {},
      providerCapabilities: {},
      providerFeatures: {},
      targetCapabilities: {},
      limits: {},
    }
  );
}

function mergeCapabilityMaps(
  left: Record<string, boolean>,
  right: Record<string, boolean>
): Record<string, boolean> {
  return { ...left, ...right };
}

function mergeTargetCapabilities(
  left: Record<string, Record<string, boolean>> | undefined,
  right: Record<string, Record<string, boolean>> | undefined
): Record<string, Record<string, boolean>> | undefined {
  if (!left && !right) {
    return undefined;
  }
  const keys = new Set([...(left ? Object.keys(left) : []), ...(right ? Object.keys(right) : [])]);
  const merged: Record<string, Record<string, boolean>> = {};
  for (const key of keys) {
    merged[key] = {
      ...(left?.[key] ?? {}),
      ...(right?.[key] ?? {}),
    };
  }
  return merged;
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
