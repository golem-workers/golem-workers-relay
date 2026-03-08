import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type AudioTaskMedia } from "./transcription.js";

type OpenRouterChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type AudioFormat = "wav" | "mp3" | "webm" | "ogg" | "flac" | "aac" | "aiff" | "m4a";
type PreparedOpenRouterAudio = {
  dataB64: string;
  format: "wav" | "mp3";
};

const execFileAsync = promisify(execFile);

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

  const preparedAudio = await prepareAudioForOpenRouter({
    media: input.media,
    timeoutMs: input.timeoutMs,
  });

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
                  data: preparedAudio.dataB64,
                  format: preparedAudio.format,
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

export async function prepareAudioForOpenRouter(
  input: {
    media: AudioTaskMedia;
    timeoutMs: number;
  },
  deps?: {
    convertAudioToWav?: (input: {
      media: AudioTaskMedia;
      sourceFormat: AudioFormat;
      timeoutMs: number;
    }) => Promise<string>;
  }
): Promise<PreparedOpenRouterAudio> {
  const sourceFormat = resolveAudioFormat(input.media);
  if (!sourceFormat) {
    throw new Error(`Unsupported audio content type for OpenRouter STT: ${input.media.contentType}`);
  }
  if (sourceFormat === "wav" || sourceFormat === "mp3") {
    return {
      dataB64: input.media.dataB64,
      format: sourceFormat,
    };
  }

  const convertAudioToWav = deps?.convertAudioToWav ?? convertAudioToWavWithFfmpeg;
  return {
    dataB64: await convertAudioToWav({
      media: input.media,
      sourceFormat,
      timeoutMs: input.timeoutMs,
    }),
    format: "wav",
  };
}

function resolveAudioFormat(media: AudioTaskMedia): AudioFormat | null {
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

async function convertAudioToWavWithFfmpeg(input: {
  media: AudioTaskMedia;
  sourceFormat: AudioFormat;
  timeoutMs: number;
}): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-stt-"));
  const inputPath = path.join(tempDir, `input.${extensionForAudioFormat(input.sourceFormat)}`);
  const outputPath = path.join(tempDir, "output.wav");
  try {
    await fs.writeFile(inputPath, Buffer.from(input.media.dataB64, "base64"));
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ],
      {
        timeout: Math.max(1000, input.timeoutMs),
        maxBuffer: 1024 * 1024,
      }
    );
    const output = await fs.readFile(outputPath);
    if (output.length === 0) {
      throw new Error("ffmpeg produced an empty wav output");
    }
    return output.toString("base64");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      throw new Error("ffmpeg is required to transcribe this audio format on the relay host");
    }
    if (isErrorWithSignal(error, "SIGTERM")) {
      throw new Error("Audio conversion timed out before transcription");
    }
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function extensionForAudioFormat(format: AudioFormat): string {
  return format === "m4a" ? "m4a" : format;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function isErrorWithSignal(error: unknown, signal: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "signal" in error &&
    (error as { signal?: unknown }).signal === signal
  );
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
