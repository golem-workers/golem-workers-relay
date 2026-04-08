import { z } from "zod";

const jsonRecordSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.record(z.string(), z.unknown())
);

export const agentControlActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config.read"),
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
    contextTokens: z.number().int().positive().nullable().optional(),
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
]);

export type AgentControlAction = z.infer<typeof agentControlActionSchema>;

export const agentControlResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("config.read"),
    configText: z.string().min(1),
    config: jsonRecordSchema,
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
    contextTokens: z.number().int().positive().nullable(),
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
