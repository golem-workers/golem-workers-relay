import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationActivityIndex } from "./activityIndex.js";
import { deliverSystemNotificationFromRelay } from "./systemNotificationDelivery.js";
import type { BackendClient } from "../backend/backendClient.js";
import type { InboundPushMessage } from "../backend/types.js";

describe("deliverSystemNotificationFromRelay", () => {
  it("uses the activity index route and asks backend to append backend-owned channel messages", async () => {
    const index = new ConversationActivityIndex({ filePath: await tempIndexPath() });
    await index.recordInbound({
      sessionKey: "webchat:conversation-1",
      channel: "webchat",
      transportTarget: { conversationId: "conversation-1" },
      text: "last active webchat",
      userId: "user_1",
      at: Date.now(),
    });
    const deliverSystemNotification = vi.fn().mockResolvedValue({
      accepted: true,
      backendMessageId: "system-notification:notif_1:webchat:conversation-1",
    });
    const backend = { deliverSystemNotification } as unknown as BackendClient;

    const result = await deliverSystemNotificationFromRelay({
      backend,
      activityIndex: index,
      message: systemNotificationMessage(),
    });

    expect(result).toEqual({
      status: "delivered",
      selectedChannel: "webchat",
      sessionKey: "webchat:conversation-1",
    });
    expect(deliverSystemNotification).toHaveBeenCalledWith({
      notificationId: "notif_1",
      idempotencyKey: "notif_1:webchat:conversation-1",
      sessionKey: "webchat:conversation-1",
      channel: "webchat",
      text: "Credits are exhausted",
      eventKey: "credits.exhausted",
      severity: "warning",
      rawTaskResult: { userNotificationId: "notif_1" },
    });
  });

  it("returns no_route when no user-visible route is known", async () => {
    const index = new ConversationActivityIndex({ filePath: await tempIndexPath() });
    const backend = { deliverSystemNotification: vi.fn() } as unknown as BackendClient;

    const result = await deliverSystemNotificationFromRelay({
      backend,
      activityIndex: index,
      message: systemNotificationMessage(),
    });

    expect(result).toEqual({ status: "no_route" });
  });

  it("falls back to direct OpenClaw Telegram runtime sessions when the activity index is empty", async () => {
    const index = new ConversationActivityIndex({ filePath: await tempIndexPath() });
    const now = Date.now();
    const sendTelegramTransportAction = vi.fn().mockResolvedValue({
      transportMessageId: "tg-system-1",
    });
    const deliverSystemNotification = vi.fn().mockResolvedValue({
      accepted: true,
      backendMessageId: "system-notification:notif_1:tg:7278830001:openclaw-direct",
    });
    const backend = {
      sendTelegramTransportAction,
      deliverSystemNotification,
    } as unknown as BackendClient;
    const gateway = {
      request: vi.fn((method: string) => {
        if (method === "sessions.list") {
          return Promise.resolve({
            sessions: [
              {
                key: "agent:main:telegram:direct:7278830001",
                updatedAt: now,
              },
            ],
          });
        }
        if (method === "chat.history") {
          return Promise.resolve({
            messages: [
              {
                role: "user",
                content: "hello from direct telegram",
                createdAt: now,
              },
            ],
          });
        }
        return Promise.resolve({});
      }),
    };

    const result = await deliverSystemNotificationFromRelay({
      backend,
      activityIndex: index,
      message: systemNotificationMessage(),
      gateway,
    });

    expect(result).toEqual({
      status: "delivered",
      selectedChannel: "telegram",
      sessionKey: "tg:7278830001:openclaw-direct",
      transportMessageId: "tg-system-1",
    });
    expect(sendTelegramTransportAction).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      action: expect.objectContaining({
        kind: "message.send",
        transportTarget: {
          channel: "telegram",
          chatId: "7278830001",
        },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        openclawContext: expect.objectContaining({
          sessionKey: "tg:7278830001:openclaw-direct",
        }),
        payload: { text: "Credits are exhausted" },
      }),
    });
    expect(deliverSystemNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "tg:7278830001:openclaw-direct",
        channel: "telegram",
        transportMessageId: "tg-system-1",
      })
    );
    expect(index.findBestUserVisibleRoute({ userId: "user_1" })?.sessionKey).toBe(
      "tg:7278830001:openclaw-direct"
    );
  });
});

function systemNotificationMessage(): InboundPushMessage {
  return {
    messageId: "system-notification:notif_1",
    input: {
      kind: "system_notification",
      notificationId: "notif_1",
      userId: "user_1",
      text: "Credits are exhausted",
      eventKey: "credits.exhausted",
      code: "credits:exhausted",
      severity: "warning",
      rawTaskResult: { userNotificationId: "notif_1" },
    },
  };
}

async function tempIndexPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-system-notification-"));
  return path.join(dir, "activity.json");
}
