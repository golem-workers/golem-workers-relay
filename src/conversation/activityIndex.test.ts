import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifySessionActivity,
  ConversationActivityIndex,
  inferConversationChannel,
  inferTransportTarget,
} from "./activityIndex.js";

describe("ConversationActivityIndex", () => {
  it("selects the freshest external user-visible route", async () => {
    const filePath = await tempIndexPath();
    const index = new ConversationActivityIndex({ filePath });

    await index.recordInbound({
      sessionKey: "tg:100:server-a",
      text: "older telegram",
      at: 1000,
    });
    await index.recordInbound({
      sessionKey: "webchat:conversation-1",
      channel: "webchat",
      transportTarget: { conversationId: "conversation-1" },
      text: "newer webchat",
      at: 5000,
    });

    const route = index.findBestUserVisibleRoute({ now: 6000 });

    expect(route?.sessionKey).toBe("webchat:conversation-1");
    expect(route?.channel).toBe("webchat");
    expect(route?.transportTarget?.conversationId).toBe("conversation-1");
  });

  it("does not route system notifications to maintenance main sessions", async () => {
    const filePath = await tempIndexPath();
    const index = new ConversationActivityIndex({ filePath });

    await index.recordInbound({
      sessionKey: "tg:100:server-a",
      text: "working user task",
      at: 1000,
    });
    await index.recordInbound({
      sessionKey: "main",
      text: "HEARTBEAT_OK",
      at: 9000,
    });

    const route = index.findBestUserVisibleRoute({ now: 10_000 });

    expect(route?.sessionKey).toBe("tg:100:server-a");
  });

  it("persists routes across relay restarts", async () => {
    const filePath = await tempIndexPath();
    const first = new ConversationActivityIndex({ filePath });
    await first.recordInbound({
      sessionKey: "whatsapp-personal:abc:server-a",
      text: "hello",
      at: 2000,
    });

    const second = new ConversationActivityIndex({ filePath });
    await second.load();

    const route = second.findBestUserVisibleRoute({ now: 3000 });
    expect(route?.sessionKey).toBe("whatsapp-personal:abc:server-a");
    expect(route?.channel).toBe("whatsapp_personal");
    expect(route?.transportTarget?.chatId).toBe("abc");
  });
});

describe("activity helpers", () => {
  it("classifies internal maintenance prompts", () => {
    expect(classifySessionActivity({ sessionKey: "main", latestUserText: "HEARTBEAT_OK" })).toBe(
      "maintenance"
    );
    expect(
      classifySessionActivity({
        sessionKey: "main",
        latestUserText: "Pre-compaction memory flush. Store durable memories only in memory/2026-06-01.md",
      })
    ).toBe("maintenance");
    expect(classifySessionActivity({ sessionKey: "tg:1:server", latestUserText: "hi" })).toBe(
      "external_user_chat"
    );
  });

  it("infers channel and target from session keys", () => {
    expect(inferConversationChannel("tg:-100:server")).toBe("telegram");
    expect(inferTransportTarget({ sessionKey: "tg:-100:server" })?.chatId).toBe("-100");
    expect(inferConversationChannel("whatsapp-personal:chat-1:server")).toBe("whatsapp_personal");
    expect(inferTransportTarget({ sessionKey: "whatsapp-personal:chat-1:server" })?.chatId).toBe("chat-1");
  });
});

async function tempIndexPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-activity-index-"));
  return path.join(dir, "activity.json");
}
