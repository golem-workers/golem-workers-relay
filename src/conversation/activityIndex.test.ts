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

  it("records correlated visible finality evidence separately from route freshness", async () => {
    const filePath = await tempIndexPath();
    const index = new ConversationActivityIndex({ filePath });

    await index.recordInbound({
      sessionKey: "tg:100:server-a",
      text: "please finish",
      at: 1000,
    });
    await index.recordVisibleDelivery({
      sessionKey: "tg:100:server-a",
      sourceRequestId: "adm_1",
      correlationMessageId: "adm_1",
      relayMessageId: "relay_1",
      runId: "run_1",
      visibleMessageId: "tg_out_1",
      transportMessageId: "2864",
      deliveryKind: "final",
      visibleText: "Done.",
      deliveredAt: 2000,
      recordedAt: 2100,
    });

    const finality = index.findLatestVisibleFinality({
      sessionKey: "tg:100:server-a",
      sourceRequestId: "adm_1",
    });

    expect(finality).toMatchObject({
      sessionKey: "tg:100:server-a",
      sourceRequestId: "adm_1",
      correlationMessageId: "adm_1",
      relayMessageId: "relay_1",
      runId: "run_1",
      visibleMessageId: "tg_out_1",
      transportMessageId: "2864",
      deliveryKind: "final",
      visibleText: "Done.",
    });
  });

  it("does not treat tool, block, or debug deliveries as visible finality", async () => {
    const filePath = await tempIndexPath();
    const index = new ConversationActivityIndex({ filePath });

    await index.recordVisibleDelivery({
      sessionKey: "agent:main:telegram:direct:449985919",
      channel: "direct_openclaw",
      sourceRequestId: "telegram:449985919:2855",
      correlationMessageId: "telegram:449985919:2855",
      visibleMessageId: "relay_notice_1",
      deliveryKind: "block",
      visibleText: 'TURN_FINAL: message "Sent the a..." from 04:45 is final',
      deliveredAt: 3000,
    });
    await index.recordVisibleDelivery({
      sessionKey: "agent:main:telegram:direct:449985919",
      channel: "direct_openclaw",
      sourceRequestId: "telegram:449985919:2855",
      correlationMessageId: "telegram:449985919:2855",
      visibleMessageId: "tool_1",
      deliveryKind: "tool",
      visibleText: "Checking...",
      deliveredAt: 4000,
    });

    expect(
      index.findLatestVisibleFinality({
        sessionKey: "agent:main:telegram:direct:449985919",
        sourceRequestId: "telegram:449985919:2855",
      })
    ).toBeNull();
  });

  it("treats delivered terminal fallbacks as visible finality", async () => {
    const filePath = await tempIndexPath();
    const index = new ConversationActivityIndex({ filePath });

    await index.recordVisibleDelivery({
      sessionKey: "webchat:dialog-1",
      channel: "webchat",
      sourceRequestId: "adm_2",
      visibleMessageId: "adm_error_1",
      deliveryKind: "terminal_error",
      visibleText: "The agent connection was interrupted. Please send the request again.",
      deliveredAt: 5000,
    });

    expect(
      index.findLatestVisibleFinality({
        sessionKey: "webchat:dialog-1",
        sourceRequestId: "adm_2",
      })?.deliveryKind
    ).toBe("terminal_error");
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
    expect(
      classifySessionActivity({
        sessionKey: "telegram:group:-100",
        latestUserText: "Pre-compaction memory flush. Store durable memories only in memory/2026-06-07.md",
      })
    ).toBe("maintenance");
  });

  it("infers channel and target from session keys", () => {
    expect(inferConversationChannel("tg:-100:server")).toBe("telegram");
    expect(inferTransportTarget({ sessionKey: "tg:-100:server" })?.chatId).toBe("-100");
    expect(inferConversationChannel("telegram:direct:449985919")).toBe("telegram");
    expect(inferTransportTarget({ sessionKey: "telegram:direct:449985919" })?.chatId).toBe("449985919");
    expect(inferConversationChannel("telegram:group:-100")).toBe("telegram");
    expect(inferTransportTarget({ sessionKey: "telegram:group:-100" })?.chatId).toBe("-100");
    expect(inferConversationChannel("whatsapp-personal:chat-1:server")).toBe("whatsapp_personal");
    expect(inferTransportTarget({ sessionKey: "whatsapp-personal:chat-1:server" })?.chatId).toBe("chat-1");
  });
});

async function tempIndexPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-activity-index-"));
  return path.join(dir, "activity.json");
}
