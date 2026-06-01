import { type BackendClient } from "../backend/backendClient.js";
import { executeTelegramTransportActionViaBackend } from "../relayChannel/telegramBackendTransport.js";
import { executeWhatsAppPersonalMessageSend } from "../relayChannel/whatsappPersonalTransport.js";
import { type ConversationActivityIndex } from "./activityIndex.js";
import type { InboundPushMessage } from "../backend/types.js";

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
}): Promise<SystemNotificationDeliveryResult> {
  if (input.message.input.kind !== "system_notification") {
    throw new Error("system_notification payload expected");
  }
  const task = input.message.input;
  const route = input.activityIndex.findBestUserVisibleRoute({
    userId: task.userId,
  });
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
