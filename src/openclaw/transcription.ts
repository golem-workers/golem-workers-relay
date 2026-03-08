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

export type TaskMedia = AudioTaskMedia | FileTaskMedia;

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
