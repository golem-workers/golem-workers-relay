import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudioWithOpenAi } from "./openaiTranscription.js";

const sampleMedia = {
  type: "audio" as const,
  dataB64: Buffer.from("voice-bytes", "utf8").toString("base64"),
  contentType: "audio/ogg",
  fileName: "voice.ogg",
};

describe("transcribeAudioWithOpenAi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls OpenAI transcriptions API and returns transcript", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ text: "hello from whisper" }), { status: 200 }));

    const transcript = await transcribeAudioWithOpenAi({
      media: sampleMedia,
      apiKey: "openai-key",
      model: "whisper-1",
      language: "ru",
      timeoutMs: 1000,
    });

    expect(transcript).toBe("hello from whisper");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer openai-key",
      }),
    );
  });

  it("throws on empty transcript", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "   " }), { status: 200 }));

    await expect(
      transcribeAudioWithOpenAi({
        media: sampleMedia,
        apiKey: "openai-key",
        model: "whisper-1",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("OpenAI transcription returned an empty transcript");
  });

  it("throws normalized timeout error on AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await expect(
      transcribeAudioWithOpenAi({
        media: sampleMedia,
        apiKey: "openai-key",
        model: "whisper-1",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("OpenAI transcription timed out");
  });
});
