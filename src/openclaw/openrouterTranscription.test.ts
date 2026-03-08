import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAudioForOpenRouter, transcribeAudioWithOpenRouter } from "./openrouterTranscription.js";

describe("transcribeAudioWithOpenRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends OpenRouter chat completion audio payload and returns transcript text", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "hello from audio",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    const transcript = await transcribeAudioWithOpenRouter({
      baseUrl: "http://127.0.0.1:18080/api/v1/",
      model: "openrouter/openai/gpt-audio",
      timeoutMs: 1000,
      media: {
        type: "audio",
        contentType: "audio/mpeg",
        fileName: "voice.mp3",
        dataB64: Buffer.from("voice").toString("base64"),
      },
    });

    expect(transcript).toBe("hello from audio");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:18080/api/v1/chat/completions");

    const requestInit = fetchSpy.mock.calls[0]?.[1];
    expect(requestInit).toBeDefined();
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(typeof requestInit?.body).toBe("string");
    if (!requestInit || typeof requestInit.body !== "string") {
      throw new Error("Expected fetch request body to be a JSON string");
    }
    const payload = JSON.parse(requestInit.body) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; input_audio?: { format: string } }> }>;
    };
    expect(payload.model).toBe("openrouter/openai/gpt-audio");
    expect(payload.messages[0]?.content[1]).toMatchObject({
      type: "input_audio",
      input_audio: {
        format: "mp3",
      },
    });
  });

  it("extracts text from structured message content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "first line" },
                  { type: "text", text: "second line" },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );

    const transcript = await transcribeAudioWithOpenRouter({
      baseUrl: "http://127.0.0.1:18080/api/v1",
      model: "openrouter/openai/gpt-audio",
      timeoutMs: 1000,
      media: {
        type: "audio",
        contentType: "audio/mpeg",
        dataB64: Buffer.from("voice").toString("base64"),
      },
    });

    expect(transcript).toBe("first line\nsecond line");
  });

  it("fails fast on unsupported audio formats", async () => {
    await expect(
      transcribeAudioWithOpenRouter({
        baseUrl: "http://127.0.0.1:18080/api/v1",
        model: "openrouter/openai/gpt-audio",
        timeoutMs: 1000,
        media: {
          type: "audio",
          contentType: "application/octet-stream",
          dataB64: Buffer.from("voice").toString("base64"),
        },
      })
    ).rejects.toThrow("Unsupported audio content type");
  });

  it("converts unsupported formats to wav before sending to OpenRouter", async () => {
    const convertedAudio = Buffer.from("converted-wav").toString("base64");

    const prepared = await prepareAudioForOpenRouter(
      {
        timeoutMs: 1000,
        media: {
          type: "audio",
          contentType: "audio/ogg",
          fileName: "voice.ogg",
          dataB64: Buffer.from("ogg-audio").toString("base64"),
        },
      },
      {
        convertAudioToWav: vi.fn().mockResolvedValue(convertedAudio),
      }
    );

    expect(prepared).toEqual({
      dataB64: convertedAudio,
      format: "wav",
    });
  });
});
