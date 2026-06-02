import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BackendClient } from "../backend/backendClient.js";
import { ConversationActivityIndex } from "../conversation/activityIndex.js";
import {
  analyzeDiagnosticLogs,
  createRelayDiagnosticNotifier,
  formatDiagnosticNotification,
} from "./errorDiagnostics.js";

describe("relay error diagnostics", () => {
  it("groups known runtime error signals", () => {
    const analysis = analyzeDiagnosticLogs([
      {
        source: "user:openclaw-gateway.service",
        text: "context-engine compaction failed: RELAY_UNAUTHORIZED Invalid relay token",
      },
      {
        source: "user:openclaw-gateway.service",
        text: "codex app-server turn idle timed out waiting for completion",
      },
      {
        source: "system:golem-workers-relay.service",
        text: "relay-openai-proxy request failed UPSTREAM_TIMEOUT",
      },
    ]);

    expect(analysis.issueCount).toBe(3);
    expect(analysis.issues.map((issue) => issue.code)).toEqual([
      "relay_auth",
      "provider_proxy",
      "openclaw_turn_timeout",
    ]);
    expect(formatDiagnosticNotification({ analysis, lookbackMs: 600_000, relayInstanceId: "relay-1" })).toContain(
      "Relay diagnostics detected 3 runtime error signal(s)"
    );
  });

  it("ignores relay restart and startup noise", () => {
    const analysis = analyzeDiagnosticLogs([
      {
        source: "system:golem-workers-relay.service",
        text: "golem-workers-relay.service: State 'final-sigterm' timed out. Killing.",
      },
      {
        source: "system:golem-workers-relay.service",
        text: "golem-workers-relay.service: Failed with result 'timeout'.",
      },
      {
        source: "system:golem-workers-relay.service",
        text: '{"level":30,"time":1780411638688,"pid":1361038,"hostname":"ubuntu-fc-uvm","host":"127.0.0.1","port":43130,"msg":"Relay-channel data plane listening"}',
      },
      {
        source: "system:golem-workers-relay.service",
        text: '{"level":40,"time":1780411633938,"pid":1301364,"hostname":"ubuntu-fc-uvm","error":"Gateway connection lost while waiting for run 0aca2ad60a1f313dc2ed169fbb79c496: Gateway client stopped","msg":"Gateway disconnected while waiting for a terminal chat event"}',
      },
    ]);

    expect(analysis.issueCount).toBe(0);
    expect(analysis.issues).toEqual([]);
  });

  it("delivers a throttled system notification through the activity route", async () => {
    const index = new ConversationActivityIndex({ filePath: await tempIndexPath() });
    let nowMs = Date.now();
    await index.recordInbound({
      sessionKey: "webchat:conversation-1",
      channel: "webchat",
      transportTarget: { conversationId: "conversation-1" },
      text: "hello",
      userId: "user_1",
      at: nowMs,
    });
    const deliverSystemNotification = vi.fn().mockResolvedValue({
      accepted: true,
      backendMessageId: "system-notification:notif_1:webchat:conversation-1",
    });
    const backend = { deliverSystemNotification } as unknown as BackendClient;
    const notifier = createRelayDiagnosticNotifier({
      settings: {
        enabled: true,
        intervalMs: 300_000,
        lookbackMs: 600_000,
        throttleMs: 600_000,
        maxLines: 100,
        journalUserUnits: [],
        journalSystemUnits: [],
        logFiles: [],
        targetUserId: null,
      },
      backend,
      activityIndex: index,
      relayInstanceId: "relay-1",
      now: () => nowMs,
      collectLogs: () =>
        Promise.resolve([
          {
            source: "user:openclaw-gateway.service",
            text: "Auto-compaction could not recover this turn",
          },
        ]),
    });

    await notifier.runOnce();
    await notifier.runOnce();
    nowMs += 600_001;
    await notifier.runOnce();

    expect(deliverSystemNotification).toHaveBeenCalledTimes(2);
    expect(deliverSystemNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationId: expect.stringContaining("relay-diagnostics:relay-1:"),
        sessionKey: "webchat:conversation-1",
        channel: "webchat",
        eventKey: "relay.diagnostics.compaction_failure",
        severity: "error",
      })
    );
  });
});

async function tempIndexPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-relay-diagnostics-"));
  return path.join(dir, "activity.json");
}
