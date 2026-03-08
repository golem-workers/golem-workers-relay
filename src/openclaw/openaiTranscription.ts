import { type AudioTaskMedia } from "./transcription.js";
import { prepareAudioForOpenRouter } from "./openrouterTranscription.js";

export async function transcribeAudioWithOpenAi(input: {
  media: AudioTaskMedia;
  baseUrl: string;
  relayToken: string;
  model: string;
  timeoutMs: number;
}): Promise<string> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OpenAI transcription base URL is empty");
  }
  const relayToken = input.relayToken.trim();
  if (!relayToken) {
    throw new Error("Relay token is empty for OpenAI transcription proxy");
  }
  const model = input.model.trim();
  if (!model) {
    throw new Error("OpenAI transcription model is empty");
  }

  const body = Buffer.from(input.media.dataB64, "base64");
  if (body.length === 0) {
    throw new Error("Audio payload is empty");
  }

  const preparedAudio = await prepareAudioForOpenRouter({
    media: input.media,
    timeoutMs: input.timeoutMs,
  });
  const fileName = guessFileName(preparedAudio.format);
  const fileContentType = preparedAudio.format === "mp3" ? "audio/mpeg" : "audio/wav";
  const file = new File([Buffer.from(preparedAudio.dataB64, "base64")], fileName, {
    type: fileContentType,
  });
  const form = new FormData();
  form.set("file", file);
  form.set("model", model);
  form.set("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs));
  try {
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${relayToken}`,
        "x-openai-stt-model": model,
      },
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const message = raw.trim().slice(0, 500) || `HTTP ${response.status}`;
      throw new Error(`OpenAI transcription request failed: ${message}`);
    }

    const payload = (await response.json()) as { text?: string };
    const transcript = payload.text?.trim() ?? "";
    if (!transcript) {
      throw new Error("OpenAI transcription returned an empty transcript");
    }
    return transcript;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI transcription timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function guessFileName(format: "wav" | "mp3"): string {
  return format === "mp3" ? "audio.mp3" : "audio.wav";
}
