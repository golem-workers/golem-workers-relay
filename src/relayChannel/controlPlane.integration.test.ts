import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./startControlPlaneServer.js";
import { executeTelegramTransportActionViaBackend } from "./telegramBackendTransport.js";
import { createRelayChannelTransportDeliveryTracker } from "./transportDeliveryTracker.js";

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
      executeAgentControl: vi.fn().mockResolvedValue({
        kind: "config.read",
        configText: "{\n  \"ok\": true\n}\n",
        config: { ok: true },
      }),
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

  it("records legacy uncorrelated telegram actions against the active relay task", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));
    const transportDeliveryTracker = createRelayChannelTransportDeliveryTracker();
    transportDeliveryTracker.begin({
      correlationMessageId: "backend_msg_1",
      sessionKey: "tg:123:srv_1",
    });

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        sendTelegramTransportAction: vi.fn().mockResolvedValue({
          transportMessageId: "1002",
          conversationId: "123",
        }),
        registerTelegramMessageCorrelation: vi.fn().mockResolvedValue({ accepted: true }),
        sendWhatsAppPersonalTransportMessage: vi.fn(),
      } as never,
      transportDeliveryTracker,
      getDataPlane: () => {
        const s = dp.getState();
        return {
          uploadBaseUrl: s.uploadBaseUrl,
          downloadBaseUrl: s.downloadBaseUrl,
          registerDownload: dp.registerDownload,
        };
      },
      executeAgentControl: vi.fn().mockResolvedValue({
        kind: "config.read",
        configText: "{\n  \"ok\": true\n}\n",
        config: { ok: true },
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    const address = cp.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await fetch(`http://127.0.0.1:${port}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "request",
        requestType: "transport.action",
        requestId: "req-legacy-1",
        action: {
          actionId: "act-legacy-1",
          kind: "message.send",
          idempotencyKey: "idem-legacy-1",
          accountId: "acc-test",
          transportTarget: { channel: "telegram", chatId: "123" },
          conversation: { handle: "123" },
          openclawContext: { deliveryKind: "final" },
          payload: { text: "already sent" },
        },
      }),
    });

    expect(transportDeliveryTracker.getSdkDelivery({ correlationMessageId: "backend_msg_1" })).toEqual({
      transportChannelId: "telegram",
      transportMessageId: "1002",
    });

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
      executeAgentControl: vi.fn().mockResolvedValue({
        kind: "config.read",
        configText: "{\n  \"ok\": true\n}\n",
        config: { ok: true },
      }),
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

  it("converts telegram mediaUrls into a backend mediaGroup", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "relay-mediaurls-"));
    try {
      const firstPath = path.join(tempDir, "a.md");
      const secondPath = path.join(tempDir, "b.md");
      await writeFile(firstPath, "# first\n");
      await writeFile(secondPath, "# second\n");
      const sendTelegramTransportAction = vi.fn().mockResolvedValue({
        transportMessageId: "202",
        transportMessageIds: ["201", "202"],
        conversationId: "123",
      });

      const result = await executeTelegramTransportActionViaBackend({
        backend: {
          sendTelegramTransportAction,
        } as never,
        action: {
          kind: "message.send",
          transportTarget: { channel: "telegram", chatId: "123" },
          openclawContext: {
            backendMessageId: "backend_1",
            runId: "run_1",
            sessionKey: "tg:123:srv_1",
          },
          payload: {
            text: "docs",
            mediaUrls: [firstPath, secondPath],
            forceDocument: true,
          },
        },
      });

      expect(result).toMatchObject({
        transportMessageId: "202",
        transportMessageIds: ["201", "202"],
        conversationId: "123",
      });
      const sentActionInput = sendTelegramTransportAction.mock.calls[0]?.[0] as
        | {
            action?: {
              kind?: string;
              transportTarget?: Record<string, string>;
              openclawContext?: Record<string, string>;
              payload?: {
                text?: string;
                mediaGroup?: Array<{ fileName?: string; contentType?: string; forceDocument?: boolean }>;
              };
            };
          }
        | undefined;
      expect(sentActionInput?.action?.kind).toBe("message.send");
      expect(sentActionInput?.action?.transportTarget).toEqual({ channel: "telegram", chatId: "123" });
      expect(sentActionInput?.action?.openclawContext).toEqual({
        backendMessageId: "backend_1",
        runId: "run_1",
        sessionKey: "tg:123:srv_1",
      });
      expect(sentActionInput?.action?.payload?.text).toBe("docs");
      expect(sentActionInput?.action?.payload?.mediaGroup).toEqual([
        expect.objectContaining({
          fileName: "a.md",
          contentType: "text/markdown",
          forceDocument: true,
        }),
        expect.objectContaining({
          fileName: "b.md",
          contentType: "text/markdown",
          forceDocument: true,
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("publishes events to plugin ingress over local HTTP", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));
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
    await new Promise<void>((resolve) => pluginIngress.listen(0, "127.0.0.1", () => resolve()));
    const pluginAddress = pluginIngress.address();
    const pluginPort = typeof pluginAddress === "object" && pluginAddress ? pluginAddress.port : 0;

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      pluginEventBaseUrl: `http://127.0.0.1:${pluginPort}`,
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
      executeAgentControl: vi.fn().mockResolvedValue({
        kind: "config.read",
        configText: "{\n  \"ok\": true\n}\n",
        config: { ok: true },
      }),
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));

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

  it("handles agent.control requests over local HTTP", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const executeAgentControl = vi.fn().mockResolvedValue({
      kind: "devicePairing.list",
      pending: [{ requestId: "req_1" }],
      paired: [{ deviceId: "dev_1" }],
    });
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
      executeAgentControl,
    });
    await new Promise<void>((resolve) => cp.server.once("listening", resolve));
    const address = cp.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const completed = (await (
      await fetch(`http://127.0.0.1:${port}/agent-control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "request",
          requestType: "agent.control",
          requestId: "req-agent-1",
          action: {
            kind: "devicePairing.list",
          },
        }),
      })
    ).json()) as { eventType?: string; payload?: { result?: { kind?: string; pending?: unknown[] } } };

    expect(executeAgentControl).toHaveBeenCalledWith({
      kind: "devicePairing.list",
    });
    expect(completed.eventType).toBe("agent.control.completed");
    expect(completed.payload?.result?.kind).toBe("devicePairing.list");
    expect(completed.payload?.result?.pending).toEqual([{ requestId: "req_1" }]);

    await cp.close();
    await closeHttpServer(dp.server);
  });
});
