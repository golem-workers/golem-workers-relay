import { describe, expect, it, vi } from "vitest";
import { BackendClient } from "./backendClient.js";

describe("BackendClient", () => {
  it("submits inbound message to backend messages endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BackendClient({
      baseUrl: "http://127.0.0.1:3000",
      relayToken: "token",
      devLogEnabled: false,
    });

    await expect(
      client.submitInboundMessage({
        body: {
          relayInstanceId: "relay-1",
          relayMessageId: "relay-msg-1",
          finishedAtMs: Date.now(),
          outcome: "reply",
          reply: { text: "ok" },
        },
      })
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes write breaker state shape", () => {
    const client = new BackendClient({
      baseUrl: "http://127.0.0.1:3000",
      relayToken: "token",
      devLogEnabled: false,
    });
    const state = client.getResilienceState();
    expect(state.writeBreaker).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("submits OpenClaw connection status to backend", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BackendClient({
      baseUrl: "http://127.0.0.1:3000",
      relayToken: "token",
      devLogEnabled: false,
    });

    await expect(
      client.submitOpenclawStatus({
        body: {
          relayInstanceId: "relay-1",
          observedAtMs: Date.now(),
          status: "DISCONNECTED",
          reason: "Gateway websocket closed (1006)",
        },
      })
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/v1/relays/openclaw-status",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("registers telegram transport correlations with backend", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BackendClient({
      baseUrl: "http://127.0.0.1:3000",
      relayToken: "token",
      devLogEnabled: false,
    });

    await expect(
      client.registerTelegramMessageCorrelation({
        chatId: "-100123",
        transportMessageId: "77",
        conversationHandle: "-100123",
      })
    ).resolves.toEqual({ accepted: true });
    await expect(
      client.registerTelegramPollCorrelation({
        pollId: "poll_1",
        chatId: "-100123",
        transportMessageId: "77",
        conversationHandle: "-100123",
        threadHandle: "555",
      })
    ).resolves.toEqual({ accepted: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:3000/api/v1/relays/transport/telegram/message-correlation",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3000/api/v1/relays/transport/telegram/poll-correlation",
      expect.objectContaining({ method: "POST" })
    );
  });
});
