import path from "node:path";
import sharp from "sharp";
import { type FileTaskMedia, type ImageTaskMedia, type TaskMedia, type VideoTaskMedia } from "./transcription.js";

// Bound both encoded input memory and decoder work before resizing untrusted media.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const VISION_OUTPUT_MIME = "image/png";

export type PreparedChatMedia = {
  messageText: string;
  visionMedia: ImageTaskMedia[];
  uploadMedia: Array<FileTaskMedia | ImageTaskMedia | VideoTaskMedia>;
};

export async function prepareChatMedia(input: {
  messageText: string;
  media?: TaskMedia[];
}): Promise<PreparedChatMedia> {
  const visionMedia: ImageTaskMedia[] = [];
  const uploadMedia: Array<FileTaskMedia | ImageTaskMedia | VideoTaskMedia> = [];

  for (const item of input.media ?? []) {
    if (item.type === "file") {
      uploadMedia.push(item);
      continue;
    }
    if (item.type === "image") {
      const normalized = await normalizeImageMedia(item);
      visionMedia.push(normalized);
      uploadMedia.push(normalized);
      continue;
    }
    if (item.type === "video") {
      uploadMedia.push(item);
    }
  }

  return {
    messageText: input.messageText,
    visionMedia,
    uploadMedia,
  };
}

async function normalizeImageMedia(media: ImageTaskMedia): Promise<ImageTaskMedia> {
  if (media.dataB64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error("Image exceeds the 20 MiB input limit");
  }
  const inputBuffer = Buffer.from(media.dataB64, "base64");
  if (inputBuffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image exceeds the 20 MiB input limit");
  }
  const outputBuffer = await compressVisionImageBuffer(inputBuffer);
  return {
    type: "image",
    dataB64: outputBuffer.toString("base64"),
    contentType: VISION_OUTPUT_MIME,
    fileName: forcePngFileName(media.fileName, "image-preview.png"),
  };
}

async function compressVisionImageBuffer(inputBuffer: Buffer): Promise<Buffer> {
  return sharp(inputBuffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(640, 480, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png({
      palette: true,
      quality: 10,
      effort: 10,
      compressionLevel: 9,
      colours: 256,
    })
    .toBuffer();
}

function forcePngFileName(fileName: string | undefined, fallback: string): string {
  const base = path.basename((fileName ?? "").trim()) || fallback;
  const ext = path.extname(base);
  const withoutExt = ext ? base.slice(0, -ext.length) : base;
  const safeBase = withoutExt.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "preview";
  return `${safeBase}.png`;
}
