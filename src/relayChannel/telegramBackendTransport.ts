import fs from "node:fs/promises";
import { type BackendClient } from "../backend/backendClient.js";
import { readString, resolveMedia } from "./transportMedia.js";

type TelegramTransportAction = {
  kind?: string;
  transportTarget: Record<string, string>;
  thread?: { handle?: string | null; threadId?: string | null };
  reply?: { replyToTransportMessageId?: string | null };
  payload: Record<string, unknown>;
};

function readTelegramParseMode(value: unknown): "HTML" | "MarkdownV2" | "Markdown" | undefined {
  return value === "HTML" || value === "MarkdownV2" || value === "Markdown" ? value : undefined;
}

function readTelegramChatAction(
  value: unknown
):
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "choose_sticker"
  | "find_location"
  | "record_video_note"
  | "upload_video_note"
  | undefined {
  return value === "typing" ||
    value === "upload_photo" ||
    value === "record_video" ||
    value === "upload_video" ||
    value === "record_voice" ||
    value === "upload_voice" ||
    value === "upload_document" ||
    value === "choose_sticker" ||
    value === "find_location" ||
    value === "record_video_note" ||
    value === "upload_video_note"
    ? value
    : undefined;
}

export async function executeTelegramTransportActionViaBackend(input: {
  backend: BackendClient;
  action: TelegramTransportAction;
  registerDownload?: (download: {
    body: Buffer;
    contentType: string;
    fileName: string;
  }) => { token: string; downloadUrl: string };
}): Promise<{
  transportMessageId?: string;
  conversationId?: string;
  threadId?: string;
  downloadUrl?: string;
  token?: string;
}> {
  const chatId = readString(input.action.transportTarget.chatId);
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID_MISSING");
  }

  const payload = input.action.payload;
  const mediaUrl = readString(payload.mediaUrl);
  const text = readString(payload.text) ?? undefined;
  const fileId = readString(payload.fileId) ?? undefined;
  const parseMode = readTelegramParseMode(payload.parseMode);
  const chatAction = readTelegramChatAction(payload.chatAction);
  const media =
    mediaUrl
      ? await (async () => {
          const resolved = await resolveMedia({
            mediaUrl,
            fileName: readString(payload.fileName),
            contentType: readString(payload.contentType),
          });
          return {
            dataB64: (await fs.readFile(resolved.filePath)).toString("base64"),
            fileName: resolved.fileName,
            contentType: resolved.contentType,
            ...(payload.asVoice === true ? { asVoice: true } : {}),
            ...(payload.forceDocument === true ? { forceDocument: true } : {}),
          };
        })()
      : undefined;

  const result = await input.backend.sendTelegramTransportAction({
    action: {
      kind:
        input.action.kind === "message.send" ||
        input.action.kind === "typing.set" ||
        input.action.kind === "file.download.request"
          ? input.action.kind
          : "message.send",
      transportTarget: {
        channel: "telegram",
        chatId,
      },
      ...(input.action.thread ? { thread: input.action.thread } : {}),
      ...(input.action.reply ? { reply: input.action.reply } : {}),
      payload: {
        ...(text ? { text } : {}),
        ...(fileId ? { fileId } : {}),
        ...(media ? { media } : {}),
        ...(parseMode ? { parseMode } : {}),
        ...(typeof payload.disableWebPagePreview === "boolean"
          ? { disableWebPagePreview: payload.disableWebPagePreview }
          : {}),
        ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
        ...(chatAction ? { chatAction } : {}),
      },
    },
  });

  if (result.download) {
    if (!input.registerDownload) {
      throw new Error("RELAY_DATA_PLANE_DOWNLOADS_UNAVAILABLE");
    }
    const download = input.registerDownload({
      body: Buffer.from(result.download.dataB64, "base64"),
      contentType: result.download.contentType,
      fileName: result.download.fileName,
    });
    return {
      ...(result.transportMessageId ? { transportMessageId: result.transportMessageId } : {}),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      ...(result.threadId ? { threadId: result.threadId } : {}),
      downloadUrl: download.downloadUrl,
      token: download.token,
    };
  }

  return {
    ...(result.transportMessageId ? { transportMessageId: result.transportMessageId } : {}),
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.threadId ? { threadId: result.threadId } : {}),
    ...(result.downloadUrl ? { downloadUrl: result.downloadUrl } : {}),
    ...(result.token ? { token: result.token } : {}),
  };
}
