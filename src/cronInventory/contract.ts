import { createHash } from "node:crypto";
import { z } from "zod";

export const CRON_INVENTORY_SCHEMA_VERSION = 1 as const;
export const CRON_INVENTORY_MAX_JOBS = 5_000;
export const CRON_INVENTORY_MAX_BYTES = 2 * 1024 * 1024;

const nullableString = z.string().max(1_000).nullable();
const nullableTimestamp = z.number().int().nonnegative().nullable();

export const cronInventoryScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("at"), at: z.string().max(200) }).strict(),
  z
    .object({
      kind: z.literal("every"),
      everyMs: z.number().int().positive(),
      anchorMs: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cron"),
      expr: z.string().min(1).max(500),
      tz: z.string().min(1).max(200).nullable(),
      staggerMs: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("system"), expression: z.string().max(500) })
    .strict(),
  z
    .object({ kind: z.literal("unsupported"), fingerprint: z.string().min(1).max(100) })
    .strict(),
]);

const safeOpenclawPayloadSchema = z
  .object({
    kind: z.string().min(1).max(100),
    contentFingerprint: z.string().min(1).max(100),
    model: nullableString.optional(),
    fallbacks: z.array(z.string().min(1).max(500)).max(50).optional(),
    thinking: nullableString.optional(),
    timeoutSeconds: z.number().int().nonnegative().nullable().optional(),
    allowUnsafeExternalContent: z.boolean().optional(),
    lightContext: z.boolean().optional(),
    toolsAllow: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();

const safeOpenclawDeliverySchema = z
  .object({
    mode: z.string().min(1).max(100),
    channel: nullableString,
    accountId: nullableString,
    bestEffort: z.boolean(),
    targetFingerprint: nullableString,
  })
  .strict();

const safeOpenclawFailureAlertSchema = z
  .object({
    after: z.number().int().nonnegative().nullable(),
    cooldownMs: z.number().int().nonnegative().nullable(),
    mode: nullableString,
    channel: nullableString,
    accountId: nullableString,
    targetFingerprint: nullableString,
  })
  .strict();

const safeOpenclawRuntimeSchema = z
  .object({
    nextRunAtMs: nullableTimestamp,
    runningAtMs: nullableTimestamp,
    lastRunAtMs: nullableTimestamp,
    lastRunStatus: nullableString,
    lastStatus: nullableString,
    lastError: nullableString,
    lastErrorReason: nullableString,
    lastDurationMs: z.number().int().nonnegative().nullable(),
    consecutiveErrors: z.number().int().nonnegative().nullable(),
    lastFailureAlertAtMs: nullableTimestamp,
    scheduleErrorCount: z.number().int().nonnegative().nullable(),
    lastDeliveryStatus: nullableString,
    lastDeliveryError: nullableString,
    lastDelivered: z.boolean().nullable(),
  })
  .strict();

export const safeOpenclawCronJobSchema = z
  .object({
    id: z.string().min(1).max(500),
    name: z.string().min(1).max(1_000),
    description: z.string().max(2_000).nullable(),
    enabled: z.boolean(),
    deleteAfterRun: z.boolean(),
    agentId: nullableString,
    sessionKey: nullableString,
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    schedule: cronInventoryScheduleSchema,
    sessionTarget: z.string().min(1).max(200),
    wakeMode: z.string().min(1).max(100),
    payload: safeOpenclawPayloadSchema,
    delivery: safeOpenclawDeliverySchema.nullable(),
    failureAlert: z.union([safeOpenclawFailureAlertSchema, z.literal(false)]).nullable(),
    state: safeOpenclawRuntimeSchema,
  })
  .strict();

export const cronInventoryEntrySchema = z
  .object({
    source: z.enum(["OPENCLAW", "SYSTEM"]),
    sourceId: z.string().min(1).max(1_000),
    name: z.string().min(1).max(1_000),
    description: z.string().max(2_000).nullable(),
    enabled: z.boolean(),
    schedule: cronInventoryScheduleSchema,
    timezone: z.string().min(1).max(200).nullable(),
    nextRunAtMs: nullableTimestamp,
    parseStatus: z.enum(["SUPPORTED", "UNSUPPORTED", "INVALID"]),
    parseError: z.string().max(1_000).nullable(),
    configFingerprint: z.string().min(1).max(100),
    openclawJob: safeOpenclawCronJobSchema.optional(),
    system: z
      .object({
        sourcePath: z.string().min(1).max(2_000),
        line: z.number().int().positive(),
        user: z.string().min(1).max(200).nullable(),
        fingerprint: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export const cronInventoryCollectionErrorSchema = z
  .object({
    source: z.enum(["OPENCLAW", "SYSTEM"]),
    code: z.enum(["permissionDenied", "parseError", "sourceUnavailable"]),
    sourceId: z.string().min(1).max(2_000).optional(),
    message: z.string().min(1).max(1_000),
  })
  .strict();

export const cronInventorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(CRON_INVENTORY_SCHEMA_VERSION),
    collectorVersion: z.string().min(1).max(200),
    observedAt: z.string().datetime({ offset: true }),
    configHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    collectionStatus: z.enum(["COMPLETE", "PARTIAL", "FAILED"]),
    errors: z.array(cronInventoryCollectionErrorSchema).max(500),
    requestId: z.string().min(1).max(200).optional(),
    jobs: z.array(cronInventoryEntrySchema).max(CRON_INVENTORY_MAX_JOBS),
  })
  .strict();

export const cronInventoryAckSchema = z
  .object({
    accepted: z.literal(true),
    acceptedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    inventoryVersion: z.number().int().positive(),
    receivedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type CronInventoryEntry = z.infer<typeof cronInventoryEntrySchema>;
export type CronInventorySnapshot = z.infer<typeof cronInventorySnapshotSchema>;
export type CronInventoryAck = z.infer<typeof cronInventoryAckSchema>;
export type CronInventoryCollectionError = z.infer<
  typeof cronInventoryCollectionErrorSchema
>;

export function sha256Fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function buildCronInventoryConfigHash(
  jobs: readonly CronInventoryEntry[],
): string {
  const projection = [...jobs]
    .sort((left, right) =>
      `${left.source}:${left.sourceId}`.localeCompare(
        `${right.source}:${right.sourceId}`,
      ),
    )
    .map((job) => ({
      source: job.source,
      sourceId: job.sourceId,
      enabled: job.enabled,
      schedule: job.schedule,
      timezone: job.timezone,
      parseStatus: job.parseStatus,
      configFingerprint: job.configFingerprint,
    }));
  return sha256Fingerprint({
    schemaVersion: CRON_INVENTORY_SCHEMA_VERSION,
    jobs: projection,
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
