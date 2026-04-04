import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

export type ResolvedMedia = {
  filePath: string;
  fileName: string;
  contentType: string;
};

export function readString(value: unknown): string | null {
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

export async function resolveMedia(input: {
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
