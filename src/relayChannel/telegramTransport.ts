import { openAsBlob } from "node:fs";
import { readString, resolveMedia } from "./transportMedia.js";

type TelegramParseMode = "HTML" | "MarkdownV2" | "Markdown";

type TelegramSendOptions = {
  chatId: string;
  text?: string;
  caption?: string;
  parseMode?: TelegramParseMode;
  replyToMessageId?: number;
  messageThreadId?: number;
};

type TelegramApiSuccess<T> = { ok: true; result: T };
type TelegramApiFailure = { ok: false; error_code?: number; description?: string };
type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

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

class TelegramBotApi {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(input: { token: string; baseUrl?: string }) {
    this.token = input.token;
    this.baseUrl = (input.baseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  }

  private async request<T>(method: string, body: Record<string, unknown>): Promise<T> {
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

  private async requestMultipart<T>(method: string, form: FormData): Promise<T> {
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

  async sendMessage(input: TelegramSendOptions): Promise<{ message_id: number }> {
    return await this.request("sendMessage", {
      chat_id: input.chatId,
      text: input.text ?? "",
      parse_mode: input.parseMode,
      disable_web_page_preview: true,
      reply_to_message_id: input.replyToMessageId ?? undefined,
      message_thread_id: input.messageThreadId ?? undefined,
    });
  }

  async sendMediaFile(input: TelegramSendOptions & {
    method: "sendPhoto" | "sendDocument" | "sendVideo" | "sendAudio" | "sendVoice";
    fieldName: "photo" | "document" | "video" | "audio" | "voice";
    filePath: string;
    fileName: string;
    contentType?: string;
  }): Promise<{ message_id: number }> {
    const blob = await openAsBlob(input.filePath, {
      type: input.contentType?.trim() || "application/octet-stream",
    });
    const form = new FormData();
    form.append("chat_id", input.chatId);
    if (input.caption && input.caption.trim()) {
      form.append("caption", input.caption);
    }
    if (input.parseMode) {
      form.append("parse_mode", input.parseMode);
    }
    if (input.replyToMessageId) {
      form.append("reply_to_message_id", input.replyToMessageId);
    }
    if (input.messageThreadId) {
      form.append("message_thread_id", input.messageThreadId);
    }
    form.append(input.fieldName, blob, input.fileName);
    return await this.requestMultipart(input.method, form);
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

export async function executeTelegramMessageSend(input: {
  accessKey: string;
  apiBaseUrl?: string;
  action: {
    transportTarget: Record<string, string>;
    thread?: { threadId?: string | null };
    reply?: { replyToTransportMessageId?: string | null };
    payload: Record<string, unknown>;
  };
}): Promise<{ transportMessageId: string }> {
  const api = new TelegramBotApi({
    token: input.accessKey,
    baseUrl: input.apiBaseUrl,
  });
  const chatId = readString(input.action.transportTarget.chatId);
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID_MISSING");
  }
  const text = readString(input.action.payload.text) ?? "";
  const mediaUrl = readString(input.action.payload.mediaUrl);
  const forceDocument = input.action.payload.forceDocument === true;
  const asVoice = input.action.payload.asVoice === true;
  const replyToMessageId = parseTelegramInteger(
    readString(input.action.reply?.replyToTransportMessageId),
    "reply_to_message_id"
  );
  const messageThreadId = parseTelegramInteger(readString(input.action.thread?.threadId), "message_thread_id");

  if (!mediaUrl) {
    const sent = await api.sendMessage({
      chatId,
      text,
      replyToMessageId,
      messageThreadId,
    });
    return { transportMessageId: String(sent.message_id) };
  }

  const media = await resolveMedia({
    mediaUrl,
    fileName: readString(input.action.payload.fileName),
    contentType: readString(input.action.payload.contentType),
  });
  const common = {
    chatId,
    caption: text || undefined,
    replyToMessageId,
    messageThreadId,
    filePath: media.filePath,
    fileName: media.fileName,
    contentType: media.contentType,
  };
  const sent = shouldSendAsPhoto(media.contentType, forceDocument)
    ? await api.sendMediaFile({
        ...common,
        method: "sendPhoto",
        fieldName: "photo",
      })
    : shouldSendAsVideo(media.contentType, forceDocument)
      ? await api.sendMediaFile({
          ...common,
          method: "sendVideo",
          fieldName: "video",
        })
      : shouldSendAsVoice(media.contentType, asVoice, forceDocument)
        ? await api.sendMediaFile({
            ...common,
            method: "sendVoice",
            fieldName: "voice",
          })
        : shouldSendAsAudio(media.contentType, forceDocument)
          ? await api.sendMediaFile({
              ...common,
              method: "sendAudio",
              fieldName: "audio",
            })
          : await api.sendMediaFile({
              ...common,
              method: "sendDocument",
              fieldName: "document",
            });
  return { transportMessageId: String(sent.message_id) };
}
