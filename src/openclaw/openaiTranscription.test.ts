import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudioWithOpenAi } from "./openaiTranscription.js";

const sampleMedia = {
  type: "audio" as const,
  dataB64: Buffer.from("voice-bytes", "utf8").toString("base64"),
  contentType: "audio/mpeg",
  fileName: "voice.mp3",
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
      baseUrl: "https://backend.example.com/api/v1/relays/openai/",
      relayToken: "relay-token",
      model: "gpt-4o-transcribe",
      timeoutMs: 1000,
    });

    expect(transcript).toBe("hello from whisper");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://backend.example.com/api/v1/relays/openai/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer relay-token",
        "x-openai-stt-model": "gpt-4o-transcribe",
      }),
    );
  });

  it("throws on empty transcript", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "   " }), { status: 200 }));

    await expect(
      transcribeAudioWithOpenAi({
        media: sampleMedia,
        baseUrl: "https://backend.example.com/api/v1/relays/openai",
        relayToken: "relay-token",
        model: "gpt-4o-transcribe",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("OpenAI transcription returned an empty transcript");
  });

  it("throws normalized timeout error on AbortError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    await expect(
      transcribeAudioWithOpenAi({
        media: sampleMedia,
        baseUrl: "https://backend.example.com/api/v1/relays/openai",
        relayToken: "relay-token",
        model: "gpt-4o-transcribe",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("OpenAI transcription timed out");
  });
});
