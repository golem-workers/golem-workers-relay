import path from "node:path";
import { openAsBlob } from "node:fs";
import { readString, resolveMedia } from "./transportMedia.js";

type TelegramParseMode = "HTML" | "MarkdownV2" | "Markdown";
type TelegramMediaMethod = "sendPhoto" | "sendDocument" | "sendVideo" | "sendAudio" | "sendVoice";
type TelegramMediaField = "photo" | "document" | "video" | "audio" | "voice";
type TelegramChatAction =
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
  | "upload_video_note";

type TelegramSendOptions = {
  chatId: string;
  text?: string;
  caption?: string;
  parseMode?: TelegramParseMode;
  replyToMessageId?: number;
  messageThreadId?: number;
  replyMarkup?: Record<string, unknown>;
};

type TelegramApiSuccess<T> = { ok: true; result: T };
type TelegramApiFailure = { ok: false; error_code?: number; description?: string };
type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

type TelegramActionEnvelope = {
  kind?: string;
  transportTarget: Record<string, string>;
  thread?: { threadId?: string | null };
  reply?: { replyToTransportMessageId?: string | null };
  payload: Record<string, unknown>;
};

type TelegramDownloadRegistration = {
  downloadUrl: string;
  token: string;
};

function formatTelegramApiError(status: number, payload: TelegramApiFailure | null): Error {
  if (payload) {
    return new Error(`Telegram API error ${payload.error_code ?? status}: ${payload.description ?? "Unknown error"}`);
  }
  return new Error(`Telegram API HTTP error: ${status}`);
}

function parseTelegramInteger(value: string | null | undefined, fieldName: string): number | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Telegram ${fieldName} must be a positive integer, got: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Telegram ${fieldName} must be a safe positive integer, got: ${value}`);
  }
  return parsed;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readParseMode(value: unknown): TelegramParseMode | undefined {
  return value === "HTML" || value === "MarkdownV2" || value === "Markdown" ? value : undefined;
}

function inferContentTypeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".mp4":
      return "video/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

class TelegramBotApi {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;
  private readonly token: string;

  constructor(input: { token: string; baseUrl?: string; fileBaseUrl?: string }) {
    this.token = input.token;
    this.baseUrl = (input.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
    this.fileBaseUrl = (input.fileBaseUrl ?? input.baseUrl ?? "https://api.telegram.org").replace(
      /\/$/,
      ""
    );
  }

  async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (payload && !payload.ok) {
      throw formatTelegramApiError(response.status, payload);
    }
    if (!response.ok || !payload?.ok) {
      throw formatTelegramApiError(response.status, null);
    }
    return payload.result;
  }

  async requestMultipart<T>(method: string, form: FormData): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
    if (payload && !payload.ok) {
      throw formatTelegramApiError(response.status, payload);
    }
    if (!response.ok || !payload?.ok) {
      throw formatTelegramApiError(response.status, null);
    }
    return payload.result;
  }

  private appendCommonSendFields(
    form: FormData,
    input: Pick<
      TelegramSendOptions,
      "chatId" | "caption" | "parseMode" | "replyToMessageId" | "messageThreadId" | "replyMarkup"
    >
  ) {
    form.append("chat_id", input.chatId);
    if (input.caption && input.caption.trim()) {
      form.append("caption", input.caption);
    }
    if (input.parseMode) {
      form.append("parse_mode", input.parseMode);
    }
    if (input.replyToMessageId) {
      form.append("reply_to_message_id", String(input.replyToMessageId));
    }
    if (input.messageThreadId) {
      form.append("message_thread_id", String(input.messageThreadId));
    }
    if (input.replyMarkup) {
      form.append("reply_markup", JSON.stringify(input.replyMarkup));
    }
  }

  async sendMessage(
    input: TelegramSendOptions & { disableWebPagePreview?: boolean }
  ): Promise<{ message_id: number }> {
    return await this.request("sendMessage", {
      chat_id: input.chatId,
      text: input.text ?? "",
      parse_mode: input.parseMode,
      disable_web_page_preview: input.disableWebPagePreview ?? true,
      reply_to_message_id: input.replyToMessageId ?? undefined,
      message_thread_id: input.messageThreadId ?? undefined,
      reply_markup: input.replyMarkup ?? undefined,
    });
  }

  async sendMediaFile(
    input: TelegramSendOptions & {
      method: TelegramMediaMethod;
      fieldName: TelegramMediaField;
      filePath: string;
      fileName: string;
      contentType?: string;
    }
  ): Promise<{ message_id: number }> {
    const blob = await openAsBlob(input.filePath, {
      type: input.contentType?.trim() || "application/octet-stream",
    });
    const form = new FormData();
    this.appendCommonSendFields(form, input);
    form.append(input.fieldName, blob, input.fileName);
    return await this.requestMultipart(input.method, form);
  }

  async sendMediaRef(
    input: TelegramSendOptions & {
      method: TelegramMediaMethod;
      fieldName: TelegramMediaField;
      media: string;
    }
  ): Promise<{ message_id: number }> {
    return await this.request(input.method, {
      chat_id: input.chatId,
      [input.fieldName]: input.media,
      caption: input.caption,
      parse_mode: input.parseMode,
      reply_to_message_id: input.replyToMessageId ?? undefined,
      message_thread_id: input.messageThreadId ?? undefined,
      reply_markup: input.replyMarkup ?? undefined,
    });
  }

  async sendMediaGroup(input: {
    chatId: string;
    media: Array<Record<string, unknown>>;
    files?: Array<{ attachName: string; filePath: string; fileName: string; contentType?: string }>;
    replyToMessageId?: number;
    messageThreadId?: number;
  }): Promise<Array<{ message_id: number }>> {
    const form = new FormData();
    form.append("chat_id", input.chatId);
    form.append("media", JSON.stringify(input.media));
    if (input.replyToMessageId) {
      form.append("reply_to_message_id", String(input.replyToMessageId));
    }
    if (input.messageThreadId) {
      form.append("message_thread_id", String(input.messageThreadId));
    }
    for (const file of input.files ?? []) {
      const blob = await openAsBlob(file.filePath, {
        type: file.contentType?.trim() || "application/octet-stream",
      });
      form.append(file.attachName, blob, file.fileName);
    }
    return await this.requestMultipart("sendMediaGroup", form);
  }

  async sendChatAction(input: { chatId: string; action: TelegramChatAction }): Promise<true> {
    return await this.request("sendChatAction", {
      chat_id: input.chatId,
      action: input.action,
    });
  }

  async getFile(input: { fileId: string }): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return await this.request("getFile", {
      file_id: input.fileId,
    });
  }

  async downloadFileByPath(input: { filePath: string }): Promise<Buffer> {
    const response = await fetch(`${this.fileBaseUrl}/file/bot${this.token}/${input.filePath}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function shouldSendAsPhoto(contentType: string, forceDocument: boolean): boolean {
  return !forceDocument && /^image\/(png|jpeg|jpg|gif|webp)$/i.test(contentType);
}

function shouldSendAsVideo(contentType: string, forceDocument: boolean): boolean {
  return !forceDocument && /^video\//i.test(contentType);
}

function shouldSendAsVoice(contentType: string, asVoice: boolean, forceDocument: boolean): boolean {
  return !forceDocument && asVoice && /^audio\//i.test(contentType);
}

function shouldSendAsAudio(contentType: string, forceDocument: boolean): boolean {
  return !forceDocument && /^audio\//i.test(contentType);
}

function getTelegramMediaSendDescriptor(input: {
  contentType: string;
  asVoice: boolean;
  forceDocument: boolean;
  explicitMediaType?: string | null;
}): { method: TelegramMediaMethod; fieldName: TelegramMediaField; mediaGroupType: "photo" | "video" | "audio" | "document" } {
  const explicit = input.explicitMediaType?.trim().toLowerCase();
  if (explicit === "photo" || explicit === "image") {
    return { method: "sendPhoto", fieldName: "photo", mediaGroupType: "photo" };
  }
  if (explicit === "video") {
    return { method: "sendVideo", fieldName: "video", mediaGroupType: "video" };
  }
  if (explicit === "voice") {
    return { method: "sendVoice", fieldName: "voice", mediaGroupType: "audio" };
  }
  if (explicit === "audio") {
    return { method: "sendAudio", fieldName: "audio", mediaGroupType: "audio" };
  }
  if (explicit === "document" || explicit === "file") {
    return { method: "sendDocument", fieldName: "document", mediaGroupType: "document" };
  }
  if (shouldSendAsPhoto(input.contentType, input.forceDocument)) {
    return { method: "sendPhoto", fieldName: "photo", mediaGroupType: "photo" };
  }
  if (shouldSendAsVideo(input.contentType, input.forceDocument)) {
    return { method: "sendVideo", fieldName: "video", mediaGroupType: "video" };
  }
  if (shouldSendAsVoice(input.contentType, input.asVoice, input.forceDocument)) {
    return { method: "sendVoice", fieldName: "voice", mediaGroupType: "audio" };
  }
  if (shouldSendAsAudio(input.contentType, input.forceDocument)) {
    return { method: "sendAudio", fieldName: "audio", mediaGroupType: "audio" };
  }
  return { method: "sendDocument", fieldName: "document", mediaGroupType: "document" };
}

function buildBaseResult(input: { chatId: string; messageThreadId?: number }) {
  return {
    conversationId: input.chatId,
    ...(input.messageThreadId ? { threadId: String(input.messageThreadId) } : {}),
  };
}

function readTransportMessageId(payload: Record<string, unknown>): string {
  const transportMessageId =
    readString(payload.transportMessageId) ??
    readString(payload.messageId) ??
    readString(payload.targetTransportMessageId);
  if (!transportMessageId) {
    throw new Error("TELEGRAM_TRANSPORT_MESSAGE_ID_MISSING");
  }
  return transportMessageId;
}

async function sendSingleTelegramMedia(input: {
  api: TelegramBotApi;
  chatId: string;
  payload: Record<string, unknown>;
  replyToMessageId?: number;
  messageThreadId?: number;
}): Promise<{ transportMessageId: string }> {
  const text = readString(input.payload.text);
  const caption = readString(input.payload.caption) ?? text ?? undefined;
  const parseMode = readParseMode(input.payload.parseMode);
  const replyMarkup = readRecord(input.payload.replyMarkup) ?? undefined;
  const forceDocument = input.payload.forceDocument === true;
  const asVoice = input.payload.asVoice === true;
  const explicitMediaType = readString(input.payload.mediaType);
  const descriptor = getTelegramMediaSendDescriptor({
    contentType:
      readString(input.payload.contentType) ??
      inferContentTypeFromFileName(readString(input.payload.fileName) ?? "attachment"),
    asVoice,
    forceDocument,
    explicitMediaType,
  });
  const fileId = readString(input.payload.fileId);
  if (fileId) {
    const sent = await input.api.sendMediaRef({
      chatId: input.chatId,
      caption,
      parseMode,
      replyToMessageId: input.replyToMessageId,
      messageThreadId: input.messageThreadId,
      replyMarkup,
      method: descriptor.method,
      fieldName: descriptor.fieldName,
      media: fileId,
    });
    return { transportMessageId: String(sent.message_id) };
  }

  const mediaUrl = readString(input.payload.mediaUrl);
  if (!mediaUrl) {
    throw new Error("TELEGRAM_MEDIA_URL_OR_FILE_ID_REQUIRED");
  }
  const media = await resolveMedia({
    mediaUrl,
    fileName: readString(input.payload.fileName),
    contentType: readString(input.payload.contentType),
  });
  const sent = await input.api.sendMediaFile({
    chatId: input.chatId,
    caption,
    parseMode,
    replyToMessageId: input.replyToMessageId,
    messageThreadId: input.messageThreadId,
    replyMarkup,
    method: descriptor.method,
    fieldName: descriptor.fieldName,
    filePath: media.filePath,
    fileName: media.fileName,
    contentType: media.contentType,
  });
  return { transportMessageId: String(sent.message_id) };
}

async function sendTelegramMediaGroup(input: {
  api: TelegramBotApi;
  chatId: string;
  payload: Record<string, unknown>;
  replyToMessageId?: number;
  messageThreadId?: number;
}): Promise<{ transportMessageId?: string }> {
  const itemsRaw = Array.isArray(input.payload.mediaGroup)
    ? input.payload.mediaGroup
    : Array.isArray(input.payload.media)
      ? input.payload.media
      : null;
  if (!itemsRaw || itemsRaw.length === 0) {
    throw new Error("TELEGRAM_MEDIA_GROUP_ITEMS_REQUIRED");
  }
  const parseMode = readParseMode(input.payload.parseMode);
  const caption = readString(input.payload.caption) ?? readString(input.payload.text) ?? undefined;
  const files: Array<{ attachName: string; filePath: string; fileName: string; contentType?: string }> = [];
  const media = await Promise.all(
    itemsRaw.map(async (itemRaw, index) => {
      const item = readRecord(itemRaw);
      if (!item) {
        throw new Error("TELEGRAM_MEDIA_GROUP_ITEM_INVALID");
      }
      const fileId = readString(item.fileId);
      const fileName = readString(item.fileName) ?? `attachment-${index + 1}`;
      const contentType =
        readString(item.contentType) ?? inferContentTypeFromFileName(fileName);
      const descriptor = getTelegramMediaSendDescriptor({
        contentType,
        asVoice: item.asVoice === true,
        forceDocument: item.forceDocument === true,
        explicitMediaType: readString(item.mediaType),
      });
      const mediaRef = fileId
        ? fileId
        : await (async () => {
            const mediaUrl = readString(item.mediaUrl);
            if (!mediaUrl) {
              throw new Error("TELEGRAM_MEDIA_GROUP_ITEM_MEDIA_URL_OR_FILE_ID_REQUIRED");
            }
            const resolved = await resolveMedia({
              mediaUrl,
              fileName,
              contentType,
            });
            const attachName = `file${index}`;
            files.push({
              attachName,
              filePath: resolved.filePath,
              fileName: resolved.fileName,
              contentType: resolved.contentType,
            });
            return `attach://${attachName}`;
          })();
      return {
        type: descriptor.mediaGroupType,
        media: mediaRef,
        ...(index === 0 && caption ? { caption } : {}),
        ...(index === 0 && parseMode ? { parse_mode: parseMode } : {}),
      };
    })
  );
  const sent = await input.api.sendMediaGroup({
    chatId: input.chatId,
    media,
    files,
    replyToMessageId: input.replyToMessageId,
    messageThreadId: input.messageThreadId,
  });
  return sent[0] ? { transportMessageId: String(sent[0].message_id) } : {};
}

export async function executeTelegramTransportAction(input: {
  accessKey: string;
  apiBaseUrl?: string;
  fileBaseUrl?: string;
  action: TelegramActionEnvelope;
  registerDownload?: (input: {
    fileName: string;
    contentType: string;
    body: Buffer;
  }) => Promise<TelegramDownloadRegistration> | TelegramDownloadRegistration;
}): Promise<{
  transportMessageId?: string;
  conversationId?: string;
  threadId?: string;
  downloadUrl?: string;
  token?: string;
  pollId?: string;
}> {
  const api = new TelegramBotApi({
    token: input.accessKey,
    baseUrl: input.apiBaseUrl,
    fileBaseUrl: input.fileBaseUrl,
  });
  const chatId = readString(input.action.transportTarget.chatId);
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID_MISSING");
  }
  const payload = input.action.payload;
  const text = readString(payload.text) ?? "";
  const parseMode = readParseMode(payload.parseMode);
  const replyMarkup = readRecord(payload.replyMarkup) ?? undefined;
  const replyToMessageId = parseTelegramInteger(
    readString(input.action.reply?.replyToTransportMessageId),
    "reply_to_message_id"
  );
  const messageThreadId = parseTelegramInteger(readString(input.action.thread?.threadId), "message_thread_id");
  const baseResult = buildBaseResult({ chatId, messageThreadId });

  switch (input.action.kind) {
    case "message.send": {
      const hasMediaGroup =
        (Array.isArray(payload.mediaGroup) && payload.mediaGroup.length > 0) ||
        (Array.isArray(payload.media) && payload.media.length > 0);
      if (hasMediaGroup) {
        return {
          ...baseResult,
          ...(await sendTelegramMediaGroup({
            api,
            chatId,
            payload,
            replyToMessageId,
            messageThreadId,
          })),
        };
      }

      if (readString(payload.mediaUrl) || readString(payload.fileId)) {
        return {
          ...baseResult,
          ...(await sendSingleTelegramMedia({
            api,
            chatId,
            payload,
            replyToMessageId,
            messageThreadId,
          })),
        };
      }

      const sent = await api.sendMessage({
        chatId,
        text,
        parseMode,
        replyToMessageId,
        messageThreadId,
        replyMarkup,
        disableWebPagePreview: readBoolean(payload.disableWebPagePreview) ?? true,
      });
      return {
        ...baseResult,
        transportMessageId: String(sent.message_id),
      };
    }
    case "message.edit": {
      const transportMessageId = parseTelegramInteger(
        readTransportMessageId(payload),
        "message_id"
      );
      const caption = readString(payload.caption);
      if (caption || readBoolean(payload.editCaptionOnly) === true) {
        await api.request("editMessageCaption", {
          chat_id: chatId,
          message_id: transportMessageId,
          caption: caption ?? text,
          parse_mode: parseMode,
          reply_markup: replyMarkup ?? undefined,
        });
      } else {
        await api.request("editMessageText", {
          chat_id: chatId,
          message_id: transportMessageId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: readBoolean(payload.disableWebPagePreview) ?? true,
          reply_markup: replyMarkup ?? undefined,
        });
      }
      return {
        ...baseResult,
        transportMessageId: String(transportMessageId),
      };
    }
    case "message.delete": {
      const transportMessageId = parseTelegramInteger(
        readTransportMessageId(payload),
        "message_id"
      );
      await api.request("deleteMessage", {
        chat_id: chatId,
        message_id: transportMessageId,
      });
      return {
        ...baseResult,
        transportMessageId: String(transportMessageId),
      };
    }
    case "reaction.set": {
      const transportMessageId = parseTelegramInteger(
        readTransportMessageId(payload),
        "message_id"
      );
      const emoji = readStringArray(payload.emojis) ?? (readString(payload.emoji) ? [readString(payload.emoji)!] : []);
      await api.request("setMessageReaction", {
        chat_id: chatId,
        message_id: transportMessageId,
        reaction: emoji.map((value) => ({ type: "emoji", emoji: value })),
        is_big: readBoolean(payload.isBig) ?? undefined,
      });
      return {
        ...baseResult,
        transportMessageId: String(transportMessageId),
      };
    }
    case "typing.set": {
      const enabled = readBoolean(payload.enabled) ?? true;
      if (enabled) {
        await api.sendChatAction({
          chatId,
          action: (readString(payload.chatAction) as TelegramChatAction | null) ?? "typing",
        });
      }
      return baseResult;
    }
    case "poll.send": {
      const question = readString(payload.question);
      const options = readStringArray(payload.options);
      if (!question || !options) {
        throw new Error("TELEGRAM_POLL_QUESTION_AND_OPTIONS_REQUIRED");
      }
      const sent = await api.request<{ message_id: number; poll?: { id?: string } }>("sendPoll", {
        chat_id: chatId,
        question,
        options,
        is_anonymous: readBoolean(payload.isAnonymous) ?? undefined,
        allows_multiple_answers: readBoolean(payload.allowsMultipleAnswers) ?? undefined,
        type: readString(payload.pollType) ?? undefined,
        correct_option_id:
          typeof payload.correctOptionIndex === "number" ? payload.correctOptionIndex : undefined,
        explanation: readString(payload.explanation) ?? undefined,
        reply_to_message_id: replyToMessageId ?? undefined,
        message_thread_id: messageThreadId ?? undefined,
        reply_markup: replyMarkup ?? undefined,
      });
      return {
        ...baseResult,
        transportMessageId: String(sent.message_id),
        ...(typeof sent.poll?.id === "string" && sent.poll.id.trim().length > 0 ? { pollId: sent.poll.id } : {}),
      };
    }
    case "message.pin": {
      const transportMessageId = parseTelegramInteger(
        readTransportMessageId(payload),
        "message_id"
      );
      await api.request("pinChatMessage", {
        chat_id: chatId,
        message_id: transportMessageId,
        disable_notification: readBoolean(payload.disableNotification) ?? undefined,
      });
      return {
        ...baseResult,
        transportMessageId: String(transportMessageId),
      };
    }
    case "message.unpin": {
      const messageId = readString(payload.transportMessageId) ?? readString(payload.messageId);
      await api.request("unpinChatMessage", {
        chat_id: chatId,
        message_id: messageId ? parseTelegramInteger(messageId, "message_id") : undefined,
      });
      return {
        ...baseResult,
        ...(messageId ? { transportMessageId: messageId } : {}),
      };
    }
    case "topic.create": {
      const topicName = readString(payload.name);
      if (!topicName) {
        throw new Error("TELEGRAM_TOPIC_NAME_REQUIRED");
      }
      const created = await api.request<{ message_thread_id: number }>("createForumTopic", {
        chat_id: chatId,
        name: topicName,
        icon_color: typeof payload.iconColor === "number" ? payload.iconColor : undefined,
        icon_custom_emoji_id: readString(payload.iconCustomEmojiId) ?? undefined,
      });
      return {
        ...baseResult,
        threadId: String(created.message_thread_id),
      };
    }
    case "topic.edit": {
      const topicId = parseTelegramInteger(
        readString(payload.threadId) ?? readString(input.action.thread?.threadId),
        "message_thread_id"
      );
      if (!topicId) {
        throw new Error("TELEGRAM_TOPIC_ID_REQUIRED");
      }
      await api.request("editForumTopic", {
        chat_id: chatId,
        message_thread_id: topicId,
        name: readString(payload.name) ?? undefined,
        icon_custom_emoji_id: readString(payload.iconCustomEmojiId) ?? undefined,
      });
      return {
        ...baseResult,
        threadId: String(topicId),
      };
    }
    case "topic.close": {
      const topicId = parseTelegramInteger(
        readString(payload.threadId) ?? readString(input.action.thread?.threadId),
        "message_thread_id"
      );
      if (!topicId) {
        throw new Error("TELEGRAM_TOPIC_ID_REQUIRED");
      }
      await api.request("closeForumTopic", {
        chat_id: chatId,
        message_thread_id: topicId,
      });
      return {
        ...baseResult,
        threadId: String(topicId),
      };
    }
    case "callback.answer": {
      const callbackQueryId = readString(payload.callbackQueryId);
      if (!callbackQueryId) {
        throw new Error("TELEGRAM_CALLBACK_QUERY_ID_REQUIRED");
      }
      await api.request("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: readString(payload.text) ?? undefined,
        show_alert: readBoolean(payload.showAlert) ?? undefined,
        url: readString(payload.url) ?? undefined,
        cache_time: typeof payload.cacheTime === "number" ? payload.cacheTime : undefined,
      });
      return baseResult;
    }
    case "file.download.request": {
      const fileId = readString(payload.fileId);
      if (!fileId) {
        throw new Error("TELEGRAM_FILE_ID_REQUIRED");
      }
      if (!input.registerDownload) {
        throw new Error("RELAY_DATA_PLANE_DOWNLOADS_UNAVAILABLE");
      }
      const file = await api.getFile({ fileId });
      if (!file.file_path) {
        throw new Error("TELEGRAM_FILE_PATH_MISSING");
      }
      const body = await api.downloadFileByPath({ filePath: file.file_path });
      const fileName = path.basename(file.file_path) || `${file.file_id}.bin`;
      const download = await input.registerDownload({
        fileName,
        contentType: inferContentTypeFromFileName(fileName),
        body,
      });
      return {
        ...baseResult,
        downloadUrl: download.downloadUrl,
        token: download.token,
      };
    }
    default:
      throw new Error(`UNSUPPORTED_TELEGRAM_ACTION: ${input.action.kind ?? "unknown"}`);
  }
}

export async function executeTelegramMessageSend(input: {
  accessKey: string;
  apiBaseUrl?: string;
  fileBaseUrl?: string;
  action: {
    transportTarget: Record<string, string>;
    thread?: { threadId?: string | null };
    reply?: { replyToTransportMessageId?: string | null };
    payload: Record<string, unknown>;
  };
}): Promise<{ transportMessageId: string }> {
  const result = await executeTelegramTransportAction({
    accessKey: input.accessKey,
    apiBaseUrl: input.apiBaseUrl,
    fileBaseUrl: input.fileBaseUrl,
    action: {
      ...input.action,
      kind: "message.send",
    },
  });
  if (!result.transportMessageId) {
    throw new Error("TELEGRAM_TRANSPORT_MESSAGE_ID_MISSING");
  }
  return { transportMessageId: result.transportMessageId };
}
