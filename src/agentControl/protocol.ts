import { z } from "zod";

const jsonRecordSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.record(z.string(), z.unknown())
);
const modelAssignmentPurposeSchema = z.enum([
  "main",
  "image",
  "imageGeneration",
  "videoGeneration",
  "musicGeneration",
  "pdf",
]);
const thinkingDefaultSchema = z
  .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"])
  .nullable()
  .optional();
const modelFallbacksSchema = z.array(z.string().min(1));
const modelRefStringSchema = z.string().min(1).nullable();

export const agentControlActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config.read"),
  }),
  z.object({
    kind: z.literal("channels.status"),
  }),
  z.object({
    kind: z.literal("config.apply"),
    configText: z.string().min(1),
  }),
  z.object({
    kind: z.literal("gateway.restart"),
  }),
  z.object({
    kind: z.literal("devicePairing.list"),
  }),
  z.object({
    kind: z.literal("devicePairing.approve"),
    requestId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("channelPairing.list"),
    channel: z.string().min(1),
    accountId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("channelPairing.approve"),
    channel: z.string().min(1),
    code: z.string().min(1),
    accountId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("model.set"),
    model: z.string().min(1),
    fallbacks: modelFallbacksSchema,
    contextTokens: z.number().int().positive().nullable().optional(),
    thinkingDefault: thinkingDefaultSchema,
  }),
  z.object({
    kind: z.literal("modelAssignments.read"),
  }),
  z.object({
    kind: z.literal("modelAssignment.set"),
    purpose: modelAssignmentPurposeSchema,
    primary: z.string().min(1),
    fallback: modelRefStringSchema,
    contextTokens: z.number().int().positive().nullable().optional(),
    thinkingDefault: thinkingDefaultSchema,
  }),
  z.object({
    kind: z.literal("whatsapp.login.start"),
    forceRelink: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal("whatsapp.login.wait"),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal("codex.login.start"),
  }),
  z.object({
    kind: z.literal("codex.login.status"),
  }),
  z.object({
    kind: z.literal("github.auth.configure"),
    campaignId: z.string().min(1),
    authMethod: z.enum(["SSH_TOKEN", "GITHUB_OAUTH"]),
    githubAccount: z.string(),
    repositoryUrl: z.string(),
    accessToken: z.string().optional(),
    sshPrivateKey: z.string().optional(),
  }),
  z.object({
    kind: z.literal("github.oauth.status"),
    campaignId: z.string().min(1),
    repositoryUrl: z.string(),
  }),
  z.object({
    kind: z.literal("chat.statusNudge"),
    sessionKey: z.string().min(1),
    messageText: z.string().min(1),
    sourceBackendMessageId: z.string().min(1),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal("chat.abortTask"),
    backendMessageId: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
]);

export type AgentControlAction = z.infer<typeof agentControlActionSchema>;

export const agentControlResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config.read"),
    configText: z.string().min(1),
    config: jsonRecordSchema,
  }),
  z.object({
    kind: z.literal("channels.status"),
    snapshot: jsonRecordSchema,
  }),
  z.object({
    kind: z.literal("config.apply"),
    applied: z.literal(true),
  }),
  z.object({
    kind: z.literal("gateway.restart"),
    restarted: z.literal(true),
    activeState: z.string().min(1),
    subState: z.string().min(1),
    result: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("devicePairing.list"),
    pending: z.array(z.unknown()),
    paired: z.array(z.unknown()),
  }),
  z.object({
    kind: z.literal("devicePairing.approve"),
    approved: z.literal(true),
    payload: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("channelPairing.list"),
    requests: z.array(z.unknown()),
  }),
  z.object({
    kind: z.literal("channelPairing.approve"),
    approved: z.literal(true),
    payload: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("model.set"),
    applied: z.literal(true),
    restarted: z.literal(true),
    model: z.string().min(1),
    fallbacks: modelFallbacksSchema,
    contextTokens: z.number().int().positive().nullable(),
    thinkingDefault: thinkingDefaultSchema,
    activeState: z.string().min(1),
    subState: z.string().min(1),
    result: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("modelAssignments.read"),
    assignments: z.array(
      z.object({
        purpose: modelAssignmentPurposeSchema,
        primary: modelRefStringSchema,
        fallback: modelRefStringSchema,
      })
    ),
  }),
  z.object({
    kind: z.literal("modelAssignment.set"),
    applied: z.literal(true),
    restarted: z.literal(true),
    purpose: modelAssignmentPurposeSchema,
    primary: z.string().min(1),
    fallback: modelRefStringSchema,
    contextTokens: z.number().int().positive().nullable(),
    thinkingDefault: thinkingDefaultSchema,
    activeState: z.string().min(1),
    subState: z.string().min(1),
    result: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("whatsapp.login.start"),
    qrDataUrl: z.string().min(1).nullable(),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("whatsapp.login.wait"),
    connected: z.boolean(),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal("codex.login.start"),
    state: z.enum(["not_logged_in", "pending", "connected", "failed", "unavailable"]),
    message: z.string().min(1),
    verificationUrl: z.string().min(1).nullable(),
    userCode: z.string().min(1).nullable(),
    expiresAtMs: z.number().int().positive().nullable(),
    pollAfterMs: z.number().int().min(0).nullable(),
    profileId: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
    accountId: z.string().min(1).nullable(),
    lastError: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("codex.login.status"),
    state: z.enum(["not_logged_in", "pending", "connected", "failed", "unavailable"]),
    message: z.string().min(1),
    verificationUrl: z.string().min(1).nullable(),
    userCode: z.string().min(1).nullable(),
    expiresAtMs: z.number().int().positive().nullable(),
    pollAfterMs: z.number().int().min(0).nullable(),
    profileId: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
    accountId: z.string().min(1).nullable(),
    lastError: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("github.auth.configure"),
    configured: z.boolean(),
    authMethod: z.enum(["SSH_TOKEN", "GITHUB_OAUTH"]),
    credentialState: z.enum(["configured", "pending", "failed"]),
    message: z.string().min(1),
    repositoryReachable: z.boolean().nullable(),
    configPath: z.string().min(1),
    verificationUrl: z.string().min(1).nullable(),
    userCode: z.string().min(1).nullable(),
    pollAfterMs: z.number().int().min(0).nullable(),
  }),
  z.object({
    kind: z.literal("github.oauth.status"),
    credentialState: z.enum(["configured", "pending", "failed"]),
    message: z.string().min(1),
    repositoryReachable: z.boolean().nullable(),
    configPath: z.string().min(1),
    verificationUrl: z.string().min(1).nullable(),
    userCode: z.string().min(1).nullable(),
    pollAfterMs: z.number().int().min(0).nullable(),
  }),
  z.object({
    kind: z.literal("chat.statusNudge"),
    accepted: z.literal(true),
    runId: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("chat.abortTask"),
    aborted: z.boolean(),
  }),
]);

export type AgentControlResult = z.infer<typeof agentControlResultSchema>;

export const agentControlRequestSchema = z.object({
  type: z.literal("request"),
  requestType: z.literal("agent.control"),
  requestId: z.string().min(1),
  action: agentControlActionSchema,
});

export const agentControlAcceptedResponseSchema = z.object({
  accepted: z.literal(true),
  result: agentControlResultSchema,
});
