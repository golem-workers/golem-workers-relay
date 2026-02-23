import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type FileTaskMedia, type TaskMedia } from "./transcription.js";

const FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".openclaw");
}

function resolveUploadsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenclawStateDir(env), "workspace", "files");
}

function sanitizeFileName(fileName: string | undefined): string {
  const raw = (fileName ?? "file.bin").trim();
  const base = path.basename(raw);
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe.slice(0, 180) : "file.bin";
}

async function rotateOldFiles(input: { uploadsDir: string; nowMs: number }): Promise<void> {
  const cutoffMs = input.nowMs - FILE_RETENTION_MS;
  const entries = await fs.readdir(input.uploadsDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const filePath = path.join(input.uploadsDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoffMs) {
          await fs.unlink(filePath);
        }
      } catch {
        // Best-effort cleanup; skip files that disappear or become inaccessible.
      }
    })
  );
}

function pickFileMedia(media: TaskMedia[] | undefined): FileTaskMedia[] {
  if (!Array.isArray(media) || media.length === 0) return [];
  return media.filter((item): item is FileTaskMedia => item.type === "file");
}

export async function saveUploadedFiles(input: {
  media?: TaskMedia[];
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<string[]> {
  const fileMedia = pickFileMedia(input.media);
  if (fileMedia.length === 0) return [];

  const nowMs = input.nowMs ?? Date.now();
  const uploadsDir = resolveUploadsDir(input.env);
  await fs.mkdir(uploadsDir, { recursive: true });
  await rotateOldFiles({ uploadsDir, nowMs });

  const savedPaths: string[] = [];
  for (let i = 0; i < fileMedia.length; i += 1) {
    const file = fileMedia[i];
    const baseName = sanitizeFileName(file.fileName);
    const uniqueName = `${nowMs}-${i}-${Math.random().toString(16).slice(2, 10)}-${baseName}`;
    const absolutePath = path.join(uploadsDir, uniqueName);
    const payload = Buffer.from(file.dataB64, "base64");
    await fs.writeFile(absolutePath, payload);
    savedPaths.push(absolutePath);
  }

  return savedPaths;
}
