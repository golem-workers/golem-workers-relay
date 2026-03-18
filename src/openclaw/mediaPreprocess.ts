import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { type FileTaskMedia, type ImageTaskMedia, type TaskMedia, type VideoTaskMedia } from "./transcription.js";

const execFileAsync = promisify(execFile);
const VISION_OUTPUT_MIME = "image/png";

export type PreparedChatMedia = {
  messageText: string;
  visionMedia: ImageTaskMedia[];
  uploadMedia: Array<FileTaskMedia | ImageTaskMedia>;
};

export async function prepareChatMedia(input: {
  messageText: string;
  media?: TaskMedia[];
}): Promise<PreparedChatMedia> {
  const visionMedia: ImageTaskMedia[] = [];
  const uploadMedia: Array<FileTaskMedia | ImageTaskMedia> = [];
  let videoPreviewCount = 0;

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
      const preview = await extractVideoPreviewMedia(item);
      visionMedia.push(preview);
      uploadMedia.push(preview);
      videoPreviewCount += 1;
    }
  }

  return {
    messageText: appendVideoPreviewNotice(input.messageText, videoPreviewCount),
    visionMedia,
    uploadMedia,
  };
}

function appendVideoPreviewNotice(messageText: string, videoPreviewCount: number): string {
  if (videoPreviewCount <= 0) return messageText;
  const note =
    videoPreviewCount === 1
      ? "[Video note]\nOnly the first preview frame from the attached video is available for analysis. Do not claim that you analyzed the full video timeline."
      : `[Video note]\nOnly the first preview frame from each attached video is available for analysis (${videoPreviewCount} videos total). Do not claim that you analyzed the full video timelines.`;
  const text = messageText.trim();
  return text ? `${text}\n\n${note}` : note;
}

async function normalizeImageMedia(media: ImageTaskMedia): Promise<ImageTaskMedia> {
  const inputBuffer = Buffer.from(media.dataB64, "base64");
  const outputBuffer = await compressVisionImageBuffer(inputBuffer);
  return {
    type: "image",
    dataB64: outputBuffer.toString("base64"),
    contentType: VISION_OUTPUT_MIME,
    fileName: forcePngFileName(media.fileName, "image-preview.png"),
  };
}

async function extractVideoPreviewMedia(media: VideoTaskMedia): Promise<ImageTaskMedia> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-video-"));
  const inputPath = path.join(tempDir, makeTempVideoFileName(media.fileName, media.contentType));
  const outputPath = path.join(tempDir, "preview-source.png");
  try {
    await fs.writeFile(inputPath, Buffer.from(media.dataB64, "base64"));
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        "select=eq(n\\,0)",
        "-frames:v",
        "1",
        outputPath,
      ],
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
    const previewBuffer = await fs.readFile(outputPath);
    if (previewBuffer.byteLength <= 0) {
      throw new Error("ffmpeg produced an empty video preview");
    }
    const normalized = await compressVisionImageBuffer(previewBuffer);
    return {
      type: "image",
      dataB64: normalized.toString("base64"),
      contentType: VISION_OUTPUT_MIME,
      fileName: forcePngFileName(media.fileName, "video-preview.png"),
    };
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      throw new Error("ffmpeg is required on the relay host to extract video previews");
    }
    if (isErrorWithSignal(error, "SIGTERM")) {
      throw new Error("Video preview extraction timed out before analysis");
    }
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function compressVisionImageBuffer(inputBuffer: Buffer): Promise<Buffer> {
  return sharp(inputBuffer, { limitInputPixels: false })
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

function makeTempVideoFileName(fileName: string | undefined, contentType: string): string {
  const ext = inferVideoExtension(fileName, contentType);
  return `input.${ext}`;
}

function inferVideoExtension(fileName: string | undefined, contentType: string): string {
  const normalizedContentType = contentType.trim().toLowerCase();
  if (normalizedContentType.includes("webm")) return "webm";
  if (normalizedContentType.includes("quicktime")) return "mov";
  if (normalizedContentType.includes("x-matroska")) return "mkv";
  if (normalizedContentType.includes("mpeg")) return "mpeg";
  if (normalizedContentType.includes("avi")) return "avi";
  if (normalizedContentType.includes("mp4")) return "mp4";
  const name = (fileName ?? "").trim().toLowerCase();
  if (name.endsWith(".webm")) return "webm";
  if (name.endsWith(".mov")) return "mov";
  if (name.endsWith(".mkv")) return "mkv";
  if (name.endsWith(".mpeg") || name.endsWith(".mpg")) return "mpeg";
  if (name.endsWith(".avi")) return "avi";
  return "mp4";
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function isErrorWithSignal(error: unknown, signal: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "signal" in error &&
    (error as { signal?: unknown }).signal === signal
  );
}
