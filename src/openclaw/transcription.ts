import { logger } from "../logger.js";

export type AudioTaskMedia = {
  type: "audio";
  dataB64: string;
  contentType: string;
  fileName?: string;
};

export type FileTaskMedia = {
  type: "file";
  dataB64: string;
  contentType: string;
  fileName?: string;
};

export type ImageTaskMedia = {
  type: "image";
  dataB64: string;
  contentType: string;
  fileName?: string;
};

export type TaskMedia = AudioTaskMedia | FileTaskMedia | ImageTaskMedia;

export function composeMessageWithTranscript(input: { messageText: string; transcript: string }): string {
  const text = stripVoicePlaceholders(input.messageText);
  const transcript = input.transcript.trim();
  if (!text) return transcript;
  return `${text}\n\n[Voice transcript]\n${transcript}`;
}

function stripVoicePlaceholders(messageText: string): string {
  return messageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const normalized = line.toLowerCase();
      return normalized !== "[voice message]" && normalized !== "[voice note]";
    })
    .join("\n")
    .trim();
}

export function logTranscriptionFailure(input: { taskId: string; error: unknown }): void {
  logger.warn(
    {
      taskId: input.taskId,
      err: input.error instanceof Error ? input.error.message : String(input.error),
    },
    "Audio transcription failed"
  );
}
