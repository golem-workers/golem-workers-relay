import { z } from "zod";

export const pullRequestSchema = z.object({
  relayInstanceId: z.string().min(1),
  maxTasks: z.number().int().min(1).max(20),
  waitSeconds: z.number().int().min(0).max(30),
});

export const taskInputSchema = z.object({
  sessionKey: z.string().min(1),
  messageText: z.string().min(1),
  context: z.unknown().optional(),
});

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

export const acceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

