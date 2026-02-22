import { type AudioTaskMedia } from "./transcription.js";

export async function transcribeAudioWithOpenAi(input: {
  media: AudioTaskMedia;
  apiKey: string;
  model: string;
  language?: string;
  timeoutMs: number;
}): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is empty");
  }
  const model = input.model.trim();
  if (!model) {
    throw new Error("OpenAI transcription model is empty");
  }

  const body = Buffer.from(input.media.dataB64, "base64");
  if (body.length === 0) {
    throw new Error("Audio payload is empty");
  }

  const fileName = input.media.fileName?.trim() || guessFileName(input.media.contentType);
  const file = new File([body], fileName, { type: input.media.contentType });
  const form = new FormData();
  form.set("file", file);
  form.set("model", model);
  if (input.language?.trim()) {
    form.set("language", input.language.trim());
  }
  form.set("response_format", "json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs));
  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

function guessFileName(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("mpeg")) return "audio.mp3";
  if (normalized.includes("wav")) return "audio.wav";
  if (normalized.includes("webm")) return "audio.webm";
  if (normalized.includes("ogg")) return "audio.ogg";
  if (normalized.includes("mp4")) return "audio.mp4";
  return "audio.bin";
}
