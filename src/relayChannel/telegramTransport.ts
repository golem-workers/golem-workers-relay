import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

type TelegramParseMode = "HTML" | "MarkdownV2" | "Markdown";

type TelegramSendOptions = {
  chatId: string;
  text?: string;
  caption?: string;
  parseMode?: TelegramParseMode;
  replyToMessageId?: string | null;
  messageThreadId?: string | null;
};

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
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; error_code?: number; description?: string }
      | null;
    if (!response.ok || !payload) {
      throw new Error(`Telegram API HTTP error: ${response.status}`);
    }
    if (!payload.ok) {
      throw new Error(
        `Telegram API error ${payload.error_code ?? response.status}: ${payload.description ?? "Unknown error"}`
      );
    }
    return payload.result;
  }

  private async requestMultipart<T>(method: string, form: FormData): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok: true; result: T }
      | { ok: false; error_code?: number; description?: string }
      | null;
    if (!response.ok || !payload) {
      throw new Error(`Telegram API HTTP error: ${response.status}`);
    }
    if (!payload.ok) {
      throw new Error(
        `Telegram API error ${payload.error_code ?? response.status}: ${payload.description ?? "Unknown error"}`
      );
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

type ResolvedMedia = {
  filePath: string;
  fileName: string;
  contentType: string;
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function resolveWorkspacePath(rawPath: string): string {
  const workspaceRoot = path.join(resolveOpenclawStateDir(), "workspace");
  if (rawPath.startsWith("/workspace/")) {
    return path.join(workspaceRoot, rawPath.slice("/workspace/".length));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.join(workspaceRoot, rawPath);
}

async function resolveMedia(input: {
  mediaUrl: string;
  fileName?: string | null;
  contentType?: string | null;
}): Promise<ResolvedMedia> {
  const mediaUrl = input.mediaUrl.trim();
  if (/^https?:\/\//i.test(mediaUrl)) {
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch mediaUrl: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const tempDir = await fs.mkdtemp(path.join(resolveOpenclawStateDir(), "relay-channel-media-"));
    const fileName =
      input.fileName?.trim() ||
      path.basename(new URL(mediaUrl).pathname) ||
      "attachment";
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, bytes);
    return {
      filePath,
      fileName,
      contentType: input.contentType?.trim() || response.headers.get("content-type") || inferContentType(filePath),
    };
  }
  const filePath = mediaUrl.startsWith("file://") ? fileURLToPath(mediaUrl) : resolveWorkspacePath(mediaUrl);
  return {
    filePath,
    fileName: input.fileName?.trim() || path.basename(filePath),
    contentType: input.contentType?.trim() || inferContentType(filePath),
  };
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
  const replyToMessageId = readString(input.action.reply?.replyToTransportMessageId);
  const messageThreadId = readString(input.action.thread?.threadId);

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
