import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./startControlPlaneServer.js";

describe("relay-channel control plane", () => {
  it("completes hello and stub transport.action lifecycle", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      getDataPlaneUrls: () => {
        const s = dp.getState();
        return { uploadBaseUrl: s.uploadBaseUrl, downloadBaseUrl: s.downloadBaseUrl };
      },
    });
    await new Promise<void>((resolve) => cp.wss.once("listening", resolve));

    const wssAddr = cp.wss.address();
    const wsPort = typeof wssAddr === "object" && wssAddr ? wssAddr.port : 0;
    expect(wsPort).toBeGreaterThan(0);

    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const messages: unknown[] = [];
    socket.on("message", (raw) => {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString("utf8")
              : "";
      messages.push(JSON.parse(text));
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        role: "openclaw-channel-plugin",
        channelId: "relay-channel",
        instanceId: "inst",
        accountId: "acc-test",
        supports: {
          asyncLifecycle: true,
          fileDownloadRequests: true,
          capabilityNegotiation: true,
          accountScopedStatus: true,
        },
        requestedCapabilities: { core: ["messageSend"], optional: [] },
      })
    );

    await new Promise<void>((r) => setTimeout(r, 50));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const helloBack = messages[0] as { type?: string; role?: string; dataPlane?: unknown };
    expect(helloBack.type).toBe("hello");
    expect(helloBack.role).toBe("local-relay");
    expect(helloBack.dataPlane).toBeTruthy();

    socket.send(
      JSON.stringify({
        type: "request",
        requestType: "transport.action",
        requestId: "req-1",
        action: {
          actionId: "act-1",
          kind: "message.send",
          idempotencyKey: "idem-1",
          accountId: "acc-test",
          targetScope: "dm",
          transportTarget: { peer: "u1" },
          conversation: { transportConversationId: "conv-1" },
          payload: { text: "hi" },
        },
      })
    );

    await new Promise<void>((r) => setTimeout(r, 100));
    const events = messages.slice(1);
    const accepted = events.find(
      (m) => typeof m === "object" && m !== null && (m as { eventType?: string }).eventType === "transport.action.accepted"
    );
    const completed = events.find(
      (m) => typeof m === "object" && m !== null && (m as { eventType?: string }).eventType === "transport.action.completed"
    );
    expect(accepted).toBeTruthy();
    expect(completed).toBeTruthy();

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await cp.close();
    await closeHttpServer(dp.server);
  });
});
