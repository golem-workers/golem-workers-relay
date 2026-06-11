import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

export type ConversationChannel =
  | "telegram"
  | "whatsapp"
  | "whatsapp_personal"
  | "api"
  | "webchat"
  | "direct_openclaw"
  | "unknown";

export type ConversationActivityClassification =
  | "external_user_chat"
  | "maintenance"
  | "status_nudge"
  | "system_notification"
  | "unknown_internal";

export type ConversationTransportTarget = {
  chatId?: string;
  conversationId?: string;
  threadId?: string;
  dialogId?: string;
};

export type ConversationVisibleDeliveryKind =
  | "final"
  | "tool"
  | "block"
  | "terminal_error"
  | "terminal_no_reply";

export type ConversationVisibleDeliveryEvidence = {
  evidenceId: string;
  sessionKey: string;
  channel: ConversationChannel;
  transportTarget?: ConversationTransportTarget;
  sourceRequestId?: string;
  relayMessageId?: string;
  runId?: string;
  correlationMessageId?: string;
  visibleMessageId?: string;
  transportMessageId?: string;
  deliveryKind: ConversationVisibleDeliveryKind;
  visibleText?: string;
  mediaSummary?: string;
  deliveredAt: number;
  recordedAt: number;
};

export type ConversationActivityRecord = {
  sessionKey: string;
  channel: ConversationChannel;
  transportTarget?: ConversationTransportTarget;
  userId?: string;
  serverId?: string;
  lastUserMessageAt?: number;
  lastAssistantMessageAt?: number;
  lastTranscriptMessageAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  classification: ConversationActivityClassification;
  canReceiveSystemNotifications: boolean;
  canReceiveStatusNudge: boolean;
  visibleDeliveries?: ConversationVisibleDeliveryEvidence[];
  updatedAt: number;
};

const activityRecordSchema = z
  .object({
    sessionKey: z.string().min(1),
    channel: z.enum([
      "telegram",
      "whatsapp",
      "whatsapp_personal",
      "api",
      "webchat",
      "direct_openclaw",
      "unknown",
    ]),
    transportTarget: z
      .object({
        chatId: z.string().min(1).optional(),
        conversationId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional(),
        dialogId: z.string().min(1).optional(),
      })
      .optional(),
    userId: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    lastUserMessageAt: z.number().int().nonnegative().optional(),
    lastAssistantMessageAt: z.number().int().nonnegative().optional(),
    lastTranscriptMessageAt: z.number().int().nonnegative().optional(),
    lastInboundAt: z.number().int().nonnegative().optional(),
    lastOutboundAt: z.number().int().nonnegative().optional(),
    classification: z.enum([
      "external_user_chat",
      "maintenance",
      "status_nudge",
      "system_notification",
      "unknown_internal",
    ]),
    canReceiveSystemNotifications: z.boolean(),
    canReceiveStatusNudge: z.boolean(),
    visibleDeliveries: z
      .array(
        z
          .object({
            evidenceId: z.string().min(1),
            sessionKey: z.string().min(1),
            channel: z.enum([
              "telegram",
              "whatsapp",
              "whatsapp_personal",
              "api",
              "webchat",
              "direct_openclaw",
              "unknown",
            ]),
            transportTarget: z
              .object({
                chatId: z.string().min(1).optional(),
                conversationId: z.string().min(1).optional(),
                threadId: z.string().min(1).optional(),
                dialogId: z.string().min(1).optional(),
              })
              .optional(),
            sourceRequestId: z.string().min(1).optional(),
            relayMessageId: z.string().min(1).optional(),
            runId: z.string().min(1).optional(),
            correlationMessageId: z.string().min(1).optional(),
            visibleMessageId: z.string().min(1).optional(),
            transportMessageId: z.string().min(1).optional(),
            deliveryKind: z.enum(["final", "tool", "block", "terminal_error", "terminal_no_reply"]),
            visibleText: z.string().min(1).optional(),
            mediaSummary: z.string().min(1).optional(),
            deliveredAt: z.number().int().nonnegative(),
            recordedAt: z.number().int().nonnegative(),
          })
          .strict()
      )
      .optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const activityStoreSchema = z
  .object({
    version: z.literal(1),
    records: z.array(activityRecordSchema),
  })
  .strict();

type RecordInputBase = {
  sessionKey: string;
  channel?: ConversationChannel;
  transportTarget?: ConversationTransportTarget;
  userId?: string;
  serverId?: string;
  at?: number;
  text?: string;
};

type VisibleDeliveryInput = RecordInputBase & {
  evidenceId?: string;
  sourceRequestId?: string;
  relayMessageId?: string;
  runId?: string;
  correlationMessageId?: string;
  visibleMessageId?: string;
  transportMessageId?: string;
  deliveryKind: ConversationVisibleDeliveryKind;
  visibleText?: string;
  mediaSummary?: string;
  deliveredAt?: number;
  recordedAt?: number;
};

export function inferConversationChannel(sessionKey: string): ConversationChannel {
  if (sessionKey.startsWith("tg:")) return "telegram";
  if (sessionKey.startsWith("whatsapp-personal:")) return "whatsapp_personal";
  if (sessionKey.startsWith("whatsapp:")) return "whatsapp";
  if (sessionKey.startsWith("webchat:")) return "webchat";
  if (sessionKey.startsWith("direct:") || sessionKey.startsWith("openclaw-direct:")) return "direct_openclaw";
  if (sessionKey === "main" || sessionKey.startsWith("agent:")) return "unknown";
  return "api";
}

export function inferTransportTarget(input: {
  sessionKey: string;
  channel?: ConversationChannel;
  context?: unknown;
}): ConversationTransportTarget | undefined {
  const fromContext = readTransportTargetFromContext(input.context);
  if (fromContext) return fromContext;

  const channel = input.channel ?? inferConversationChannel(input.sessionKey);
  if (channel === "telegram") {
    const chatId = input.sessionKey.startsWith("tg:") ? input.sessionKey.slice(3).split(":")[0] : "";
    return chatId ? { chatId } : undefined;
  }
  if (channel === "whatsapp_personal") {
    const chatId = input.sessionKey.startsWith("whatsapp-personal:")
      ? input.sessionKey.slice("whatsapp-personal:".length).split(":")[0]
      : "";
    return chatId ? { chatId } : undefined;
  }
  if (channel === "whatsapp") {
    const chatId = input.sessionKey.startsWith("whatsapp:")
      ? input.sessionKey.slice("whatsapp:".length).split(":")[0]
      : "";
    return chatId ? { chatId } : undefined;
  }
  return undefined;
}

export function classifySessionActivity(input: {
  sessionKey: string;
  latestUserText?: string | null;
}): ConversationActivityClassification {
  const text = input.latestUserText?.trim().toLowerCase() ?? "";
  if (text.includes("[status_nudge]")) return "status_nudge";
  if (
    (text.includes("heartbeat_ok") ||
      text.includes("read heartbeat.md") ||
      text.includes("pre-compaction memory flush") ||
      text.includes("store durable memories only in"))
  ) {
    return "maintenance";
  }
  if (text.includes("system_notification") || text.includes("system notification")) {
    return "system_notification";
  }
  if (input.sessionKey === "main" || input.sessionKey.startsWith("agent:main:main")) {
    return text ? "unknown_internal" : "maintenance";
  }
  return "external_user_chat";
}

export function createConversationActivityIndex(input?: {
  stateDir?: string;
  filePath?: string;
}): ConversationActivityIndex {
  const stateDir = input?.stateDir ?? resolveOpenclawStateDir();
  return new ConversationActivityIndex({
    filePath: input?.filePath ?? path.join(stateDir, "agents", "main", "golem-workers", "relay-conversation-activity.json"),
  });
}

export class ConversationActivityIndex {
  private readonly records = new Map<string, ConversationActivityRecord>();

  constructor(private readonly opts: { filePath: string }) {}

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.opts.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = activityStoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn(
        { filePath: this.opts.filePath, error: parsed.error.message },
        "Ignoring invalid relay conversation activity index"
      );
      return;
    }
    this.records.clear();
    for (const record of parsed.data.records) {
      this.records.set(record.sessionKey, record);
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
    const tmp = `${this.opts.filePath}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1 as const, records: [...this.records.values()] }, null, 2),
      "utf8"
    );
    await fs.rename(tmp, this.opts.filePath);
  }

  snapshot(): ConversationActivityRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async recordInbound(input: RecordInputBase & { context?: unknown }): Promise<ConversationActivityRecord> {
    const at = input.at ?? Date.now();
    const record = this.mergeRecord({
      ...input,
      channel: input.channel ?? inferConversationChannel(input.sessionKey),
      transportTarget:
        input.transportTarget ??
        inferTransportTarget({
          sessionKey: input.sessionKey,
          channel: input.channel,
          context: input.context,
        }),
      lastInboundAt: at,
      lastUserMessageAt: at,
    });
    await this.save();
    return record;
  }

  async recordOutbound(input: RecordInputBase): Promise<ConversationActivityRecord> {
    const at = input.at ?? Date.now();
    const record = this.mergeRecord({
      ...input,
      channel: input.channel ?? inferConversationChannel(input.sessionKey),
      transportTarget: input.transportTarget ?? inferTransportTarget({ sessionKey: input.sessionKey, channel: input.channel }),
      lastOutboundAt: at,
      lastAssistantMessageAt: at,
    });
    await this.save();
    return record;
  }

  async recordVisibleDelivery(input: VisibleDeliveryInput): Promise<ConversationActivityRecord> {
    const recordedAt = input.recordedAt ?? input.at ?? Date.now();
    const deliveredAt = input.deliveredAt ?? input.at ?? recordedAt;
    const channel = input.channel ?? inferConversationChannel(input.sessionKey);
    const transportTarget =
      input.transportTarget ?? inferTransportTarget({ sessionKey: input.sessionKey, channel });
    const evidence: ConversationVisibleDeliveryEvidence = {
      evidenceId: input.evidenceId ?? buildVisibleDeliveryEvidenceId(input),
      sessionKey: input.sessionKey,
      channel,
      ...(transportTarget ? { transportTarget } : {}),
      ...(input.sourceRequestId ? { sourceRequestId: input.sourceRequestId } : {}),
      ...(input.relayMessageId ? { relayMessageId: input.relayMessageId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.correlationMessageId ? { correlationMessageId: input.correlationMessageId } : {}),
      ...(input.visibleMessageId ? { visibleMessageId: input.visibleMessageId } : {}),
      ...(input.transportMessageId ? { transportMessageId: input.transportMessageId } : {}),
      deliveryKind: input.deliveryKind,
      ...(input.visibleText ? { visibleText: input.visibleText } : {}),
      ...(input.mediaSummary ? { mediaSummary: input.mediaSummary } : {}),
      deliveredAt,
      recordedAt,
    };
    const record = this.mergeRecord({
      ...input,
      channel,
      transportTarget,
      lastOutboundAt: deliveredAt,
      lastAssistantMessageAt: deliveredAt,
      updatedAt: recordedAt,
      visibleDelivery: evidence,
    });
    await this.save();
    return record;
  }

  async recordTranscript(input: RecordInputBase & {
    lastUserMessageAt?: number;
    lastAssistantMessageAt?: number;
    lastTranscriptMessageAt?: number;
  }): Promise<ConversationActivityRecord> {
    const at = input.at ?? Date.now();
    const record = this.mergeRecord({
      ...input,
      channel: input.channel ?? inferConversationChannel(input.sessionKey),
      transportTarget: input.transportTarget ?? inferTransportTarget({ sessionKey: input.sessionKey, channel: input.channel }),
      lastUserMessageAt: input.lastUserMessageAt,
      lastAssistantMessageAt: input.lastAssistantMessageAt,
      lastTranscriptMessageAt: input.lastTranscriptMessageAt ?? input.lastUserMessageAt ?? input.lastAssistantMessageAt,
      updatedAt: at,
    });
    await this.save();
    return record;
  }

  findBestUserVisibleRoute(input?: {
    userId?: string;
    serverId?: string;
    ttlMs?: number;
    now?: number;
  }): ConversationActivityRecord | null {
    const now = input?.now ?? Date.now();
    const ttlMs = input?.ttlMs ?? 14 * 24 * 60 * 60 * 1000;
    const candidates = this.snapshot().filter((record) => {
      if (input?.userId && record.userId && record.userId !== input.userId) return false;
      if (input?.serverId && record.serverId && record.serverId !== input.serverId) return false;
      if (!record.canReceiveSystemNotifications) return false;
      if (record.classification !== "external_user_chat") return false;
      const freshness = routeFreshness(record);
      if (freshness == null) return false;
      return now - freshness <= ttlMs;
    });
    candidates.sort(compareRouteFreshness);
    return candidates[0] ?? null;
  }

  findBestNudgeCandidate(): ConversationActivityRecord | null {
    const candidates = this.snapshot().filter(
      (record) => record.canReceiveStatusNudge && record.classification === "external_user_chat"
    );
    candidates.sort(compareNudgeFreshness);
    return candidates[0] ?? null;
  }

  findLatestVisibleFinality(input: {
    sessionKey: string;
    sourceRequestId?: string;
    correlationMessageId?: string;
    afterMs?: number;
  }): ConversationVisibleDeliveryEvidence | null {
    const record = this.records.get(input.sessionKey);
    if (!record?.visibleDeliveries?.length) return null;
    const candidates = record.visibleDeliveries.filter((delivery) => {
      if (!isVisibleFinalityKind(delivery.deliveryKind)) return false;
      if (input.sourceRequestId && delivery.sourceRequestId !== input.sourceRequestId) return false;
      if (input.correlationMessageId && delivery.correlationMessageId !== input.correlationMessageId) return false;
      if (input.afterMs != null && delivery.deliveredAt < input.afterMs) return false;
      return true;
    });
    candidates.sort((a, b) => b.deliveredAt - a.deliveredAt || b.recordedAt - a.recordedAt);
    return candidates[0] ?? null;
  }

  private mergeRecord(
    input: RecordInputBase & {
      channel: ConversationChannel;
      lastUserMessageAt?: number;
      lastAssistantMessageAt?: number;
      lastTranscriptMessageAt?: number;
      lastInboundAt?: number;
      lastOutboundAt?: number;
      updatedAt?: number;
      visibleDelivery?: ConversationVisibleDeliveryEvidence;
    }
  ): ConversationActivityRecord {
    const previous = this.records.get(input.sessionKey);
    const classification = classifySessionActivity({
      sessionKey: input.sessionKey,
      latestUserText: input.text,
    });
    const updatedAt = input.updatedAt ?? input.at ?? Date.now();
    const record: ConversationActivityRecord = {
      sessionKey: input.sessionKey,
      channel: input.channel,
      ...(previous?.transportTarget || input.transportTarget
        ? { transportTarget: { ...previous?.transportTarget, ...input.transportTarget } }
        : {}),
      ...(input.userId ?? previous?.userId ? { userId: input.userId ?? previous?.userId } : {}),
      ...(input.serverId ?? previous?.serverId ? { serverId: input.serverId ?? previous?.serverId } : {}),
      lastUserMessageAt: maxDefined(previous?.lastUserMessageAt, input.lastUserMessageAt),
      lastAssistantMessageAt: maxDefined(previous?.lastAssistantMessageAt, input.lastAssistantMessageAt),
      lastTranscriptMessageAt: maxDefined(previous?.lastTranscriptMessageAt, input.lastTranscriptMessageAt),
      lastInboundAt: maxDefined(previous?.lastInboundAt, input.lastInboundAt),
      lastOutboundAt: maxDefined(previous?.lastOutboundAt, input.lastOutboundAt),
      classification,
      canReceiveSystemNotifications: classification === "external_user_chat",
      canReceiveStatusNudge: classification === "external_user_chat",
      visibleDeliveries: mergeVisibleDeliveries(previous?.visibleDeliveries, input.visibleDelivery),
      updatedAt: Math.max(previous?.updatedAt ?? 0, updatedAt),
    };
    this.records.set(record.sessionKey, record);
    return record;
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function routeFreshness(record: ConversationActivityRecord): number | undefined {
  return maxDefined(record.lastUserMessageAt, record.lastInboundAt) ?? record.lastOutboundAt ?? record.lastTranscriptMessageAt;
}

function nudgeFreshness(record: ConversationActivityRecord): number | undefined {
  return record.lastUserMessageAt ?? record.lastTranscriptMessageAt ?? record.lastInboundAt;
}

function compareRouteFreshness(a: ConversationActivityRecord, b: ConversationActivityRecord): number {
  return (routeFreshness(b) ?? 0) - (routeFreshness(a) ?? 0);
}

function compareNudgeFreshness(a: ConversationActivityRecord, b: ConversationActivityRecord): number {
  return (nudgeFreshness(b) ?? 0) - (nudgeFreshness(a) ?? 0);
}

function isVisibleFinalityKind(kind: ConversationVisibleDeliveryKind): boolean {
  return kind === "final" || kind === "terminal_error" || kind === "terminal_no_reply";
}

function buildVisibleDeliveryEvidenceId(input: VisibleDeliveryInput): string {
  const parts = [
    input.sessionKey,
    input.sourceRequestId,
    input.correlationMessageId,
    input.transportMessageId,
    input.visibleMessageId,
    input.deliveryKind,
    String(input.deliveredAt ?? input.at ?? input.recordedAt ?? Date.now()),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.join(":");
}

function mergeVisibleDeliveries(
  existing: ConversationVisibleDeliveryEvidence[] | undefined,
  next: ConversationVisibleDeliveryEvidence | undefined
): ConversationVisibleDeliveryEvidence[] | undefined {
  if (!next) return existing;
  const byId = new Map((existing ?? []).map((delivery) => [delivery.evidenceId, delivery]));
  byId.set(next.evidenceId, next);
  return [...byId.values()]
    .sort((a, b) => b.deliveredAt - a.deliveredAt || b.recordedAt - a.recordedAt)
    .slice(0, 50);
}

function readTransportTargetFromContext(context: unknown): ConversationTransportTarget | undefined {
  if (!context || typeof context !== "object") return undefined;
  const obj = context as Record<string, unknown>;
  const candidates = [obj, readObject(obj.telegram), readObject(obj.whatsappPersonal), readObject(obj.whatsapp_personal)].filter(
    Boolean
  ) as Array<Record<string, unknown>>;
  for (const candidate of candidates) {
    const chatId = readString(candidate.chatId) ?? readString(candidate.fromChatId);
    const conversationId = readString(candidate.conversationId) ?? readString(candidate.conversationHandle);
    const threadId = readString(candidate.threadId) ?? readString(candidate.threadHandle);
    const dialogId = readString(candidate.dialogId);
    if (chatId || conversationId || threadId || dialogId) {
      return {
        ...(chatId ? { chatId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(dialogId ? { dialogId } : {}),
      };
    }
  }
  return undefined;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
