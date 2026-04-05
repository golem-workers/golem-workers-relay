import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, startRelayChannelDataPlaneServer } from "./startDataPlaneServer.js";
import { startRelayChannelControlPlane } from "./startControlPlaneServer.js";

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  eventType: string,
  timeoutMs = 500
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matched = messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { eventType?: string }).eventType === eventType
    );
    if (matched) {
      return matched;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { eventType?: string }).eventType === eventType
  );
}

describe("relay-channel control plane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes hello and stub transport.action lifecycle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        getTelegramTransportConfig: () => Promise.resolve({
          accessKey: "test-token",
          apiBaseUrl: "https://api.telegram.org",
          fileBaseUrl: "https://api.telegram.org",
        }),
        registerTelegramMessageCorrelation: vi.fn().mockResolvedValue({ accepted: true }),
        sendWhatsAppPersonalTransportMessage: () =>
          Promise.resolve({
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
    await new Promise<void>((resolve) => cp.wss.once("listening", resolve));

    const wssAddr = cp.wss.address();
    const wsPort = typeof wssAddr === "object" && wssAddr ? wssAddr.port : 0;
    expect(wsPort).toBeGreaterThan(0);

    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString("utf8")
              : "";
      messages.push(JSON.parse(text) as Record<string, unknown>);
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
        requestedCapabilities: {
          core: ["messageSend"],
          optional: [],
        },
      })
    );

    await new Promise<void>((r) => setTimeout(r, 50));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const helloBack = messages[0] as {
      type?: string;
      role?: string;
      dataPlane?: unknown;
      transport?: { provider?: string };
      optionalCapabilities?: Record<string, boolean>;
      providerCapabilities?: Record<string, boolean>;
      providerProfiles?: Record<string, unknown>;
    };
    expect(helloBack.type).toBe("hello");
    expect(helloBack.role).toBe("local-relay");
    expect(helloBack.dataPlane).toBeTruthy();
    expect(helloBack.transport?.provider).toBe("multi");
    expect(helloBack.optionalCapabilities).toEqual({
      reactions: true,
      typing: true,
      pinning: true,
      fileDownloads: true,
    });
    expect(helloBack.providerProfiles).toMatchObject({
      telegram: {
        transport: { provider: "telegram" },
        optionalCapabilities: {
          reactions: true,
          typing: true,
          pinning: true,
          fileDownloads: true,
        },
        providerCapabilities: {},
      },
      whatsapp_personal: {
        transport: { provider: "whatsapp_personal" },
      },
    });

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
          transportTarget: { channel: "telegram", chatId: "123" },
          conversation: { handle: "conv-1" },
          payload: { text: "hi" },
        },
      })
    );

    const accepted = await waitForMessage(messages, "transport.action.accepted");
    const completed = await waitForMessage(messages, "transport.action.completed");
    expect(accepted).toBeTruthy();
    expect(completed).toBeTruthy();

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await cp.close();
    await closeHttpServer(dp.server);
  });

  it("completes whatsapp_personal transport.action lifecycle", async () => {
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        getTelegramTransportConfig: vi.fn(),
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
    await new Promise<void>((resolve) => cp.wss.once("listening", resolve));

    const wssAddr = cp.wss.address();
    const wsPort = typeof wssAddr === "object" && wssAddr ? wssAddr.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString("utf8")
              : "";
      messages.push(JSON.parse(text) as Record<string, unknown>);
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

    socket.send(
      JSON.stringify({
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
      })
    );

    const completed = await waitForMessage(messages, "transport.action.completed");
    expect(completed).toBeTruthy();

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await cp.close();
    await closeHttpServer(dp.server);
  });

  it("returns downloadUrl/token for telegram file download requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, result: { file_id: "file-1", file_path: "docs/test.pdf" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
        .mockResolvedValueOnce(
          new Response(Buffer.from("pdf-bytes"), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          })
        )
    );
    const dp = startRelayChannelDataPlaneServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => dp.server.once("listening", resolve));

    const cp = startRelayChannelControlPlane({
      host: "127.0.0.1",
      port: 0,
      relayInstanceId: "relay-test",
      backend: {
        getTelegramTransportConfig: () =>
          Promise.resolve({
            accessKey: "test-token",
            apiBaseUrl: "https://api.telegram.org",
            fileBaseUrl: "https://api.telegram.org",
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
    await new Promise<void>((resolve) => cp.wss.once("listening", resolve));
    const address = cp.wss.address();
    const wsPort = typeof address === "object" && address ? address.port : 0;

    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => {
      const text =
        typeof raw === "string"
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString("utf8")
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString("utf8")
              : "";
      messages.push(JSON.parse(text) as Record<string, unknown>);
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
        requestedCapabilities: { core: ["messageSend"], optional: ["fileDownloads"] },
      })
    );
    await new Promise<void>((r) => setTimeout(r, 30));

    socket.send(
      JSON.stringify({
        type: "request",
        requestType: "transport.action",
        requestId: "req-dl-1",
        action: {
          actionId: "act-dl-1",
          kind: "file.download.request",
          idempotencyKey: "idem-dl-1",
          accountId: "acc-test",
          transportTarget: { channel: "telegram", chatId: "123" },
          conversation: { handle: "conv-1" },
          payload: { fileId: "file-1" },
        },
      })
    );

    await new Promise<void>((r) => setTimeout(r, 80));
    const completed = messages.find((m) => m.eventType === "transport.action.completed");
    const payload =
      completed && typeof completed.payload === "object" && completed.payload !== null
        ? (completed.payload as { result?: { downloadUrl?: string; token?: string } })
        : null;
    expect(payload?.result?.downloadUrl).toMatch(/\/v1\/download\//);
    expect(payload?.result?.token).toBeTruthy();

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", resolve));
    await cp.close();
    await closeHttpServer(dp.server);
  });
});
