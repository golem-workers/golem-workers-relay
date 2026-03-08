import { type AudioTaskMedia } from "./transcription.js";

type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

export async function transcribeAudioWithOpenRouter(input: {
  media: AudioTaskMedia;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Promise<string> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("OpenRouter STT base URL is empty");
  }

  const model = input.model.trim();
  if (!model) {
    throw new Error("OpenRouter STT model is empty");
  }

  const body = Buffer.from(input.media.dataB64, "base64");
  if (body.length === 0) {
    throw new Error("Audio payload is empty");
  }

  const audioFormat = resolveAudioFormat(input.media);
  if (!audioFormat) {
    throw new Error(`Unsupported audio content type for OpenRouter STT: ${input.media.contentType}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs));
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Transcribe the attached audio verbatim.",
                  "Return only the transcript text.",
                  "Do not summarize, translate, add markup, or explain anything.",
                ].join(" "),
              },
              {
                type: "input_audio",
                input_audio: {
                  data: input.media.dataB64,
                  format: audioFormat,
                },
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const message = raw.trim().slice(0, 500) || `HTTP ${response.status}`;
      throw new Error(`OpenRouter transcription request failed: ${message}`);
    }

    const payload = (await response.json()) as OpenRouterChatCompletionResponse;
    const transcript = extractTranscript(payload);
    if (!transcript) {
      throw new Error("OpenRouter transcription returned an empty transcript");
    }
    return transcript;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenRouter transcription timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveAudioFormat(media: AudioTaskMedia): string | null {
  const normalizedContentType = media.contentType.trim().toLowerCase();
  const byContentType =
    normalizedContentType.includes("mpeg") || normalizedContentType.includes("mp3")
      ? "mp3"
      : normalizedContentType.includes("wav")
        ? "wav"
        : normalizedContentType.includes("webm")
          ? "webm"
          : normalizedContentType.includes("ogg")
            ? "ogg"
            : normalizedContentType.includes("flac")
              ? "flac"
              : normalizedContentType.includes("aac")
                ? "aac"
                : normalizedContentType.includes("aiff")
                  ? "aiff"
                  : normalizedContentType.includes("mp4") || normalizedContentType.includes("m4a")
                    ? "m4a"
                    : null;
  if (byContentType) return byContentType;

  const fileName = media.fileName?.trim().toLowerCase() ?? "";
  if (fileName.endsWith(".mp3")) return "mp3";
  if (fileName.endsWith(".wav")) return "wav";
  if (fileName.endsWith(".webm")) return "webm";
  if (fileName.endsWith(".ogg") || fileName.endsWith(".oga")) return "ogg";
  if (fileName.endsWith(".flac")) return "flac";
  if (fileName.endsWith(".aac")) return "aac";
  if (fileName.endsWith(".aiff") || fileName.endsWith(".aif")) return "aiff";
  if (fileName.endsWith(".m4a") || fileName.endsWith(".mp4")) return "m4a";
  return null;
}

function extractTranscript(payload: OpenRouterChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => (part?.type === "text" && typeof part.text === "string" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n")
    .trim();
}
