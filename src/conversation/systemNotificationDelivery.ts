import { type BackendClient } from "../backend/backendClient.js";
import { executeTelegramTransportActionViaBackend } from "../relayChannel/telegramBackendTransport.js";
import { executeWhatsAppPersonalMessageSend } from "../relayChannel/whatsappPersonalTransport.js";
import {
  classifySessionActivity,
  type ConversationActivityIndex,
  type ConversationActivityRecord,
} from "./activityIndex.js";
import type { InboundPushMessage } from "../backend/types.js";

type GatewayLike = {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};

export type SystemNotificationDeliveryResult = {
  status: "delivered" | "no_route" | "failed";
  selectedChannel?: string;
  sessionKey?: string;
  transportMessageId?: string;
  error?: string;
};

export async function deliverSystemNotificationFromRelay(input: {
  backend: BackendClient;
  activityIndex: ConversationActivityIndex;
  message: InboundPushMessage;
  gateway?: GatewayLike;
}): Promise<SystemNotificationDeliveryResult> {
  if (input.message.input.kind !== "system_notification") {
    throw new Error("system_notification payload expected");
  }
  const task = input.message.input;
  const route =
    input.activityIndex.findBestUserVisibleRoute({
      userId: task.userId,
    }) ??
    (await resolveDirectOpenclawTelegramRoute({
      gateway: input.gateway,
      activityIndex: input.activityIndex,
      userId: task.userId,
    }));
  if (!route) {
    return { status: "no_route" };
  }

  try {
    let transportMessageId: string | undefined;
    if (route.channel === "telegram") {
      const chatId = route.transportTarget?.chatId;
      if (!chatId) {
        return {
          status: "failed",
          selectedChannel: route.channel,
          sessionKey: route.sessionKey,
          error: "TELEGRAM_CHAT_ID_MISSING",
        };
      }
      const sent = await executeTelegramTransportActionViaBackend({
        backend: input.backend,
        action: {
          idempotencyKey: `system-notification:${task.notificationId}`,
          kind: "message.send",
          transportTarget: { channel: "telegram", chatId },
          openclawContext: {
            backendMessageId: input.message.messageId,
            correlationMessageId: input.message.messageId,
            sessionKey: route.sessionKey,
          },
          payload: { text: task.text },
        },
      });
      transportMessageId = sent.transportMessageId;
    } else if (route.channel === "whatsapp_personal") {
      const chatId = route.transportTarget?.chatId;
      if (!chatId) {
        return {
          status: "failed",
          selectedChannel: route.channel,
          sessionKey: route.sessionKey,
          error: "WHATSAPP_PERSONAL_CHAT_ID_MISSING",
        };
      }
      const sent = await executeWhatsAppPersonalMessageSend({
        backend: input.backend,
        action: {
          transportTarget: { channel: "whatsapp_personal", chatId },
          payload: { text: task.text },
        },
      });
      transportMessageId = sent.transportMessageId;
    }

    await input.backend.deliverSystemNotification({
      notificationId: task.notificationId,
      idempotencyKey: `${task.notificationId}:${route.sessionKey}`,
      sessionKey: route.sessionKey,
      channel: route.channel,
      text: task.text,
      eventKey: task.eventKey,
      severity: task.severity,
      rawTaskResult: task.rawTaskResult,
      ...(transportMessageId ? { transportMessageId } : {}),
    });
    return {
      status: "delivered",
      selectedChannel: route.channel,
      sessionKey: route.sessionKey,
      ...(transportMessageId ? { transportMessageId } : {}),
    };
  } catch (error) {
    return {
      status: "failed",
      selectedChannel: route.channel,
      sessionKey: route.sessionKey,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveDirectOpenclawTelegramRoute(input: {
  gateway?: GatewayLike;
  activityIndex: ConversationActivityIndex;
  userId: string;
}): Promise<ConversationActivityRecord | null> {
  if (!input.gateway) return null;

  let sessionsPayload: unknown;
  try {
    sessionsPayload = await input.gateway.request(
      "sessions.list",
      { agentId: "main", limit: 50 },
      { timeoutMs: 5_000 }
    );
  } catch {
    return null;
  }

  const candidates = readDirectTelegramRuntimeSessionCandidates(sessionsPayload);
  for (const candidate of candidates) {
    const historyPayload = await readRuntimeChatHistory(input.gateway, candidate.gatewaySessionKey);
    const latestUser = readLatestRuntimeUserMessage(historyPayload);
    if (!latestUser) continue;
    const routeSessionKey = `tg:${candidate.chatId}:openclaw-direct`;
    if (
      classifySessionActivity({
        sessionKey: routeSessionKey,
        latestUserText: latestUser.text,
      }) !== "external_user_chat"
    ) {
      continue;
    }
    return await input.activityIndex.recordTranscript({
      sessionKey: routeSessionKey,
      channel: "telegram",
      transportTarget: { chatId: candidate.chatId },
      userId: input.userId,
      text: latestUser.text,
      lastUserMessageAt: latestUser.timestampMs ?? candidate.updatedAtMs,
      at: Date.now(),
    });
  }
  return null;
}

function readDirectTelegramRuntimeSessionCandidates(payload: unknown): Array<{
  gatewaySessionKey: string;
  chatId: string;
  updatedAtMs: number;
}> {
  const sessions = isPlainObject(payload) && Array.isArray(payload.sessions) ? payload.sessions : [];
  return sessions
    .flatMap((session): Array<{ gatewaySessionKey: string; chatId: string; updatedAtMs: number }> => {
      if (!isPlainObject(session)) return [];
      const gatewaySessionKey = readString(session.key);
      if (!gatewaySessionKey) return [];
      const chatId = readDirectTelegramChatIdFromRuntimeSessionKey(gatewaySessionKey);
      if (!chatId) return [];
      const updatedAtMs = readTimestampMs(session.lastUserMessageAt) ?? readTimestampMs(session.updatedAt);
      if (updatedAtMs == null) return [];
      return [{ gatewaySessionKey, chatId, updatedAtMs }];
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

function readDirectTelegramChatIdFromRuntimeSessionKey(sessionKey: string): string | null {
  const normalized = sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
  const prefix = "telegram:direct:";
  if (!normalized.startsWith(prefix)) return null;
  const chatId = normalized.slice(prefix.length).split(":")[0]?.trim();
  return chatId || null;
}

async function readRuntimeChatHistory(gateway: GatewayLike, sessionKey: string): Promise<unknown> {
  try {
    return await gateway.request(
      "chat.history",
      {
        sessionKey,
        limit: 20,
        maxChars: 4_000,
      },
      { timeoutMs: 5_000 }
    );
  } catch {
    const normalized = sessionKey.startsWith("agent:main:") ? sessionKey.slice("agent:main:".length) : sessionKey;
    if (normalized === sessionKey) return null;
    return await gateway
      .request(
        "chat.history",
        {
          sessionKey: normalized,
          limit: 20,
          maxChars: 4_000,
        },
        { timeoutMs: 5_000 }
      )
      .catch(() => null);
  }
}

function readLatestRuntimeUserMessage(payload: unknown): { text: string; timestampMs?: number } | null {
  const messages: unknown[] = isPlainObject(payload) && Array.isArray(payload.messages) ? payload.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isPlainObject(message) || message.role !== "user") continue;
    const text = extractTextFromMessage(message).trim();
    if (!text) continue;
    const timestampMs = readTimestampMs(message.createdAt) ?? readTimestampMs(message.timestamp);
    return typeof timestampMs === "number" ? { text, timestampMs } : { text };
  }
  return null;
}

function extractTextFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isPlainObject(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "text" && typeof part.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return typeof message.text === "string" ? message.text : "";
}

function readTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
