import fs from "node:fs/promises";
import { type BackendClient } from "../backend/backendClient.js";
import { readString, resolveMedia } from "./transportMedia.js";

type TelegramTransportAction = {
  actionId?: string;
  idempotencyKey?: string;
  kind?: string;
  transportTarget: Record<string, string>;
  thread?: { handle?: string | null; threadId?: string | null };
  reply?: { replyToTransportMessageId?: string | null };
  openclawContext?: {
    backendMessageId?: string;
    correlationMessageId?: string;
    runId?: string;
    sessionKey?: string;
    deliveryKind?: "tool" | "block" | "final";
  };
  payload: Record<string, unknown>;
};

type ResolvedTelegramMedia = {
  dataB64: string;
  fileName: string;
  contentType: string;
  asVoice?: boolean;
  forceDocument?: boolean;
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
  transportMessageIds?: string[];
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
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const text = readString(payload.text) ?? undefined;
  const fileId = readString(payload.fileId) ?? undefined;
  const parseMode = readTelegramParseMode(payload.parseMode);
  const chatAction = readTelegramChatAction(payload.chatAction);
  const resolveMediaPayload = async (url: string): Promise<ResolvedTelegramMedia> => {
    const resolved = await resolveMedia({
      mediaUrl: url,
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
  };
  const resolvedMediaUrls = mediaUrls.length > 0 ? mediaUrls : mediaUrl ? [mediaUrl] : [];
  const resolvedMedia = await Promise.all(resolvedMediaUrls.map((url) => resolveMediaPayload(url)));
  const media = resolvedMedia[0];
  const mediaGroup = resolvedMedia.length > 1 ? resolvedMedia : undefined;

  const result = await input.backend.sendTelegramTransportAction({
    action: {
      ...(input.action.actionId ? { actionId: input.action.actionId } : {}),
      ...(input.action.idempotencyKey ? { idempotencyKey: input.action.idempotencyKey } : {}),
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
      ...(input.action.openclawContext ? { openclawContext: input.action.openclawContext } : {}),
      payload: {
        ...(text ? { text } : {}),
        ...(fileId ? { fileId } : {}),
        ...(mediaGroup ? { mediaGroup } : media ? { media } : {}),
        ...(payload.silent === true ? { silent: true } : {}),
        ...(typeof payload.disableNotification === "boolean"
          ? { disableNotification: payload.disableNotification }
          : {}),
        ...(typeof payload.nativeQuote === "object" && payload.nativeQuote !== null
          ? { nativeQuote: payload.nativeQuote as Record<string, unknown> }
          : {}),
        ...(typeof payload.channelData === "object" && payload.channelData !== null
          ? { channelData: payload.channelData as Record<string, unknown> }
          : {}),
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
      ...(result.transportMessageIds ? { transportMessageIds: result.transportMessageIds } : {}),
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
      ...(result.threadId ? { threadId: result.threadId } : {}),
      downloadUrl: download.downloadUrl,
      token: download.token,
    };
  }

  return {
    ...(result.transportMessageId ? { transportMessageId: result.transportMessageId } : {}),
    ...(result.transportMessageIds ? { transportMessageIds: result.transportMessageIds } : {}),
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.threadId ? { threadId: result.threadId } : {}),
    ...(result.downloadUrl ? { downloadUrl: result.downloadUrl } : {}),
    ...(result.token ? { token: result.token } : {}),
  };
}
