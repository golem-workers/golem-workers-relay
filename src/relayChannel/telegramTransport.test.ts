import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTelegramMessageSend, executeTelegramTransportAction } from "./telegramTransport.js";

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
        thread: { handle: "7" },
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

  it("registers download tokens for file.download.request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { file_id: "file_1", file_path: "docs/test.pdf" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("pdf-bytes"), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTelegramTransportAction({
      accessKey: "bot-token",
      fileBaseUrl: "https://api.telegram.org",
      action: {
        kind: "file.download.request",
        transportTarget: { channel: "telegram", chatId: "123" },
        payload: { fileId: "file_1" },
      },
      registerDownload: ({ fileName, contentType, body }) => {
        expect(fileName).toBe("test.pdf");
        expect(contentType).toBe("application/pdf");
        expect(body.toString("utf8")).toBe("pdf-bytes");
        return { token: "download-1", downloadUrl: "http://127.0.0.1:43129/v1/download/download-1" };
      },
    });

    expect(result).toMatchObject({
      downloadUrl: "http://127.0.0.1:43129/v1/download/download-1",
      token: "download-1",
    });
  });

  it("executes typing.set via sendChatAction", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeTelegramTransportAction({
      accessKey: "bot-token",
      action: {
        kind: "typing.set",
        transportTarget: { channel: "telegram", chatId: "123" },
        payload: { chatAction: "typing" },
      },
    });

    expect(result).toMatchObject({
      conversationId: "123",
    });
    const requestInit = fetchMock.mock.calls[0]?.[1];
    if (typeof requestInit?.body !== "string") {
      throw new Error("Expected telegram transport request body to be a JSON string");
    }
    expect(JSON.parse(requestInit.body)).toMatchObject({
      chat_id: "123",
      action: "typing",
    });
  });
});
