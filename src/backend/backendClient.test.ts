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
});
