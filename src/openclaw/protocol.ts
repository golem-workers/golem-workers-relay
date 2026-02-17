import { z } from "zod";

export const requestFrameSchema = z.object({
  type: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const responseFrameSchema = z.object({
  type: z.literal("res"),
  id: z.string().min(1),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      details: z.unknown().optional(),
      retryable: z.boolean().optional(),
      retryAfterMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const eventFrameSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1),
  payload: z.unknown().optional(),
  seq: z.number().int().min(0).optional(),
  stateVersion: z.unknown().optional(),
});

export const frameSchema = z.discriminatedUnion("type", [
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
]);

export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type EventFrame = z.infer<typeof eventFrameSchema>;
export type GatewayFrame = z.infer<typeof frameSchema>;

export const helloOkSchema = z.object({
  type: z.literal("hello-ok"),
  protocol: z.number().int().min(1),
  policy: z.object({
    tickIntervalMs: z.number().int().min(1),
  }),
  features: z
    .object({
      methods: z.array(z.string()),
      events: z.array(z.string()),
    })
    .optional(),
  auth: z
    .object({
      deviceToken: z.string().min(1),
      role: z.string().min(1),
      scopes: z.array(z.string()),
      issuedAtMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export type HelloOk = z.infer<typeof helloOkSchema>;

export const connectChallengeEventSchema = z.object({
  nonce: z.string().min(1),
  ts: z.number().int().min(0).optional(),
});

export const chatEventSchema = z.object({
  runId: z.string().min(1),
  sessionKey: z.string().min(1),
  seq: z.number().int().min(0),
  state: z.enum(["delta", "final", "aborted", "error"]),
  message: z.unknown().optional(),
  errorMessage: z.string().optional(),
  usage: z.unknown().optional(),
  stopReason: z.string().optional(),
});

export type ChatEvent = z.infer<typeof chatEventSchema>;

