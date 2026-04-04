import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTelegramMessageSend } from "./telegramTransport.js";

describe("executeTelegramMessageSend", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coerces Telegram reply and thread ids to integers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await executeTelegramMessageSend({
      accessKey: "bot-token",
      action: {
        transportTarget: { channel: "telegram", chatId: "-1001234567890" },
        thread: { threadId: "7" },
        reply: { replyToTransportMessageId: "55" },
        payload: { text: "hello" },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(typeof requestInit?.body).toBe("string");
    const body = requestInit?.body;
    if (typeof body !== "string") {
      throw new Error("Expected telegram transport request body to be a JSON string");
    }
    expect(JSON.parse(body)).toMatchObject({
      chat_id: "-1001234567890",
      text: "hello",
      reply_to_message_id: 55,
      message_thread_id: 7,
    });
  });

  it("preserves Telegram API error descriptions on HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: replied message not found" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
    );

    await expect(
      executeTelegramMessageSend({
        accessKey: "bot-token",
        action: {
          transportTarget: { channel: "telegram", chatId: "-1001234567890" },
          reply: { replyToTransportMessageId: "55" },
          payload: { text: "hello" },
        },
      })
    ).rejects.toThrow("Telegram API error 400: Bad Request: replied message not found");
  });
});
