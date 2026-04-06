import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./startControlPlaneServer.js";

const pluginIngressServers: Server[] = [];

describe("relay-channel control plane", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      pluginIngressServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
  });

  it("completes hello and synchronous telegram action lifecycle over HTTP", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        sendTelegramTransportAction: () =>
          Promise.resolve({
            transportMessageId: "1001",
            conversationId: "123",
          }),
        registerTelegramMessageCorrelation: vi.fn().mockResolvedValue({ accepted: true }),
        sendWhatsAppPersonalTransportMessage: vi.fn(),
      } as never,
      getDataPlane: () => {
        const s = dp.getState();
        return {
          uploadBaseUrl: s.uploadBaseUrl,
          downloadBaseUrl: s.downloadBaseUrl,
          registerDownload: dp.registerDownload,
        };
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    const address = cp.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const helloBack = (await (
      await fetch(`http://127.0.0.1:${port}/hello`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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
          requestedCapabilities: {
            core: ["messageSend"],
            optional: [],
          },
        }),
      })
    ).json()) as {
      type?: string;
      role?: string;
      dataPlane?: unknown;
      transport?: { provider?: string };
      optionalCapabilities?: Record<string, boolean>;
      providerProfiles?: Record<string, unknown>;
    };

    expect(helloBack.type).toBe("hello");
    expect(helloBack.role).toBe("local-relay");
    expect(helloBack.dataPlane).toBeTruthy();
    expect(helloBack.transport?.provider).toBe("multi");
    expect(helloBack.optionalCapabilities).toEqual({
      typing: true,
      fileDownloads: true,
    });
    expect(helloBack.providerProfiles).toMatchObject({
      telegram: {
        transport: { provider: "telegram" },
      },
      whatsapp_personal: {
        transport: { provider: "whatsapp_personal" },
      },
    });

    const completed = (await (
      await fetch(`http://127.0.0.1:${port}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "request",
          requestType: "transport.action",
          requestId: "req-1",
          action: {
            actionId: "act-1",
            kind: "message.send",
            idempotencyKey: "idem-1",
            accountId: "acc-test",
            transportTarget: { channel: "telegram", chatId: "123" },
            conversation: { handle: "conv-1" },
            payload: { text: "hi" },
          },
        }),
      })
    ).json()) as { eventType?: string; payload?: { result?: { transportMessageId?: string } } };

    expect(completed.eventType).toBe("transport.action.completed");
    expect(completed.payload?.result?.transportMessageId).toBe("1001");

    await cp.close();
    await closeHttpServer(dp.server);
  });

  it("completes whatsapp_personal transport.action lifecycle over HTTP", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        sendTelegramTransportAction: vi.fn(),
        registerTelegramMessageCorrelation: vi.fn().mockResolvedValue({ accepted: true }),
        sendWhatsAppPersonalTransportMessage: vi.fn().mockResolvedValue({
          transportMessageId: "wa-msg-1",
        }),
      } as never,
      getDataPlane: () => {
        const s = dp.getState();
        return {
          uploadBaseUrl: s.uploadBaseUrl,
          downloadBaseUrl: s.downloadBaseUrl,
          registerDownload: dp.registerDownload,
        };
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    const address = cp.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await fetch(`http://127.0.0.1:${port}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
      }),
    });

    const completed = (await (
      await fetch(`http://127.0.0.1:${port}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "request",
          requestType: "transport.action",
          requestId: "req-wa-1",
          action: {
            actionId: "act-wa-1",
            kind: "message.send",
            idempotencyKey: "idem-wa-1",
            accountId: "acc-test",
            transportTarget: { channel: "whatsapp_personal", chatId: "12345@s.whatsapp.net" },
            conversation: { handle: "conv-wa-1" },
            payload: { text: "hi from wa" },
          },
        }),
      })
    ).json()) as { eventType?: string };

    expect(completed.eventType).toBe("transport.action.completed");

    await cp.close();
    await closeHttpServer(dp.server);
  });

  it("publishes events to plugin ingress over local HTTP", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        sendTelegramTransportAction: vi.fn(),
        registerTelegramMessageCorrelation: vi.fn(),
        sendWhatsAppPersonalTransportMessage: vi.fn(),
      } as never,
      getDataPlane: () => {
        const s = dp.getState();
        return {
          uploadBaseUrl: s.uploadBaseUrl,
          downloadBaseUrl: s.downloadBaseUrl,
          registerDownload: dp.registerDownload,
        };
      },
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    const address = cp.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const seenEvents: Array<Record<string, unknown>> = [];

    const pluginIngress = createServer((req, res) => {
      void (async () => {
        try {
          const chunks: Uint8Array[] = [];
          for await (const chunk of req) {
            chunks.push(
              typeof chunk === "string"
                ? Buffer.from(chunk)
                : chunk instanceof Uint8Array
                  ? chunk
                  : Buffer.from(String(chunk))
            );
          }
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if (text.length > 0) {
            seenEvents.push(JSON.parse(text) as Record<string, unknown>);
          }
          res.statusCode = 202;
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false }));
        }
      })();
    });
    pluginIngressServers.push(pluginIngress);
    await new Promise<void>((resolve) => pluginIngress.listen(port + 2, "127.0.0.1", () => resolve()));

    cp.publishEvent({
      type: "event",
      eventType: "transport.typing.updated",
      payload: {
        accountId: "acc-test",
        conversation: { handle: "123" },
        typing: { active: true },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]?.eventType).toBe("transport.typing.updated");

    await cp.close();
    await closeHttpServer(dp.server);
  });
});
