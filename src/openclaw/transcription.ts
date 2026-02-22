import { logger } from "../logger.js";

export type AudioTaskMedia = {
  type: "audio";
  dataB64: string;
  contentType: string;
  fileName?: string;
};

export async function transcribeAudioWithDeepgram(input: {
  media: AudioTaskMedia;
  apiKey: string;
  language?: string;
  timeoutMs: number;
}): Promise<string> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is empty");
  }

  const body = Buffer.from(input.media.dataB64, "base64");
  if (body.length === 0) {
    throw new Error("Audio payload is empty");
  }

  const url = new URL("https://api.deepgram.com/v1/listen");
  if (input.language?.trim()) {
    url.searchParams.set("language", input.language.trim());
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, input.timeoutMs));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": input.media.contentType,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const message = raw.trim().slice(0, 500) || `HTTP ${response.status}`;
      throw new Error(`Deepgram request failed: ${message}`);
    }

    const payload = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string;
          }>;
        }>;
      };
    };
    const transcript = payload.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (!transcript) {
      throw new Error("Deepgram returned an empty transcript");
    }
    return transcript;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Deepgram transcription timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function composeMessageWithTranscript(input: { messageText: string; transcript: string }): string {
  const text = input.messageText.trim();
  const transcript = input.transcript.trim();
  if (!text) return transcript;
  return `${text}\n\n[Voice transcript]\n${transcript}`;
}

export function logTranscriptionFailure(input: { taskId: string; error: unknown }): void {
  logger.warn(
    {
      taskId: input.taskId,
      err: input.error instanceof Error ? input.error.message : String(input.error),
    },
    "Audio transcription failed; falling back to original text"
  );
}
