import fs from "node:fs/promises";
import { type BackendClient } from "../backend/backendClient.js";
import { readString, resolveMedia } from "./transportMedia.js";

export async function executeWhatsAppPersonalMessageSend(input: {
  backend: BackendClient;
  action: {
    transportTarget: Record<string, string>;
    reply?: { replyToTransportMessageId?: string | null };
    payload: Record<string, unknown>;
  };
}): Promise<{ transportMessageId: string }> {
  const chatId = readString(input.action.transportTarget.chatId);
  if (!chatId) {
    throw new Error("WHATSAPP_PERSONAL_CHAT_ID_MISSING");
  }
  const text = readString(input.action.payload.text) ?? "";
  const mediaUrl = readString(input.action.payload.mediaUrl);

  if (!mediaUrl) {
    return await input.backend.sendWhatsAppPersonalTransportMessage({
      action: {
        transportTarget: {
          channel: "whatsapp_personal",
          chatId,
        },
        reply: {
          replyToTransportMessageId: readString(input.action.reply?.replyToTransportMessageId),
        },
        payload: {
          text,
        },
      },
    });
  }

  const media = await resolveMedia({
    mediaUrl,
    fileName: readString(input.action.payload.fileName),
    contentType: readString(input.action.payload.contentType),
  });
  const dataB64 = (await fs.readFile(media.filePath)).toString("base64");

  return await input.backend.sendWhatsAppPersonalTransportMessage({
    action: {
      transportTarget: {
        channel: "whatsapp_personal",
        chatId,
      },
      reply: {
        replyToTransportMessageId: readString(input.action.reply?.replyToTransportMessageId),
      },
      payload: {
        ...(text ? { text } : {}),
        media: {
          type: classifyWhatsAppPersonalMediaType(media.contentType),
          dataB64,
          contentType: media.contentType,
          fileName: media.fileName,
          ...(input.action.payload.asVoice === true ? { asVoice: true } : {}),
        },
      },
    },
  });
}

function classifyWhatsAppPersonalMediaType(contentType: string): "audio" | "file" | "image" | "video" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}
