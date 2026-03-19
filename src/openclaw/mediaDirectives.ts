import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { type ChatEvent } from "./protocol.js";

export type TranscriptMediaFile = {
  /** The MEDIA: path as found in the transcript (relative). */
  path: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type CollectTranscriptMediaOpts = {
  stateDir?: string; // defaults to $OPENCLAW_STATE_DIR or ~/.openclaw
  maxFiles?: number;
  maxBytes?: number;
};

function resolveDefaultStateDir(): string {
  return resolveOpenclawStateDir(process.env);
}

function looksLikePlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (value as { constructor?: unknown }).constructor === Object;
}

export function extractMediaDirectivePaths(text: string): string[] {
  const out: string[] = [];
  const re = /(^|\n)\s*MEDIA:\s*([^\n\r]+)\s*(?=\r?\n|$)/g;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    const raw = (m[2] ?? "").trim();
    if (raw) out.push(raw);
  }
  // Dedupe while preserving order.
  return Array.from(new Set(out));
}

function extractTextFromReplyMessage(message: unknown): string | null {
  if (typeof message === "string") {
    const normalized = message.trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (!looksLikePlainObject(message)) return null;
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text.trim();
  }
  if (typeof message.content === "string" && message.content.trim().length > 0) {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .map((part) => {
      if (typeof part === "string" && part.trim().length > 0) {
        return part.trim();
      }
      if (looksLikePlainObject(part) && part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text.trim();
      }
      return null;
    })
    .filter((part): part is string => typeof part === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function readLatestMediaPathsFromCurrentReply(input: { message?: unknown; openclawEvents?: ChatEvent[] }): string[] {
  const candidates: unknown[] = [];
  if (input.message !== undefined) {
    candidates.push(input.message);
  }
  if (Array.isArray(input.openclawEvents)) {
    for (let i = input.openclawEvents.length - 1; i >= 0; i -= 1) {
      candidates.push(input.openclawEvents[i]?.message);
    }
  }
  for (const candidate of candidates) {
    const text = extractTextFromReplyMessage(candidate);
    if (!text) continue;
    const paths = extractMediaDirectivePaths(text);
    if (paths.length > 0) return paths;
  }
  return [];
}

function sniffContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

export async function resolveRelayMediaFile(params: {
  stateDir: string;
  workspaceRoot: string;
  mediaPath: string;
}): Promise<{ absPath: string; relPath: string }> {
  const raw = params.mediaPath.trim();
  if (!raw) {
    throw new Error("MEDIA path is empty");
  }
  const stateReal = await fs.realpath(params.stateDir).catch(() => params.stateDir);
  const workspaceReal = await fs.realpath(params.workspaceRoot).catch(() => params.workspaceRoot);
  const statePrefix = stateReal.endsWith(path.sep) ? stateReal : stateReal + path.sep;
  const workspacePrefix = workspaceReal.endsWith(path.sep) ? workspaceReal : workspaceReal + path.sep;

  // OpenClaw can emit:
  // - workspace-relative paths: MEDIA: avatars/foo.png
  // - state absolute paths: MEDIA:/root/.openclaw/media/browser/foo.png
  if (path.isAbsolute(raw)) {
    const absCandidate = path.resolve(raw);
    const absReal = await fs.realpath(absCandidate).catch(() => absCandidate);
    if (!(absReal === stateReal || absReal.startsWith(statePrefix))) {
      throw new Error("MEDIA absolute path is outside stateDir");
    }
    const relToState = path.relative(stateReal, absReal).replace(/\\/g, "/");
    return { absPath: absReal, relPath: relToState || path.basename(absReal) };
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.split("/").some((seg) => seg === "..")) {
    throw new Error("MEDIA path traversal is not allowed");
  }
  const workspaceCandidate = path.resolve(workspaceReal, normalized);
  const workspaceCandidateReal = await fs.realpath(workspaceCandidate).catch(() => workspaceCandidate);
  if (!(workspaceCandidateReal === workspaceReal || workspaceCandidateReal.startsWith(workspacePrefix))) {
    throw new Error("MEDIA path is outside workspace");
  }
  return { absPath: workspaceCandidateReal, relPath: normalized };
}

export async function collectTranscriptMedia(params: {
  message?: unknown;
  openclawEvents?: ChatEvent[];
  opts?: CollectTranscriptMediaOpts;
}): Promise<TranscriptMediaFile[]> {
  const stateDir = params.opts?.stateDir ?? resolveDefaultStateDir();
  const maxFiles = Math.max(0, Math.min(10, Math.trunc(params.opts?.maxFiles ?? 4)));
  const maxBytes = Math.max(1, Math.trunc(params.opts?.maxBytes ?? 5_000_000));
  if (maxFiles === 0) return [];
  const workspaceRoot = path.join(stateDir, "workspace");
  const mediaPaths = readLatestMediaPathsFromCurrentReply({
    message: params.message,
    openclawEvents: params.openclawEvents,
  });
  if (mediaPaths.length === 0) return [];

  const results: TranscriptMediaFile[] = [];
  for (const p of mediaPaths) {
    if (results.length >= maxFiles) break;
    try {
      const resolved = await resolveRelayMediaFile({
        stateDir,
        workspaceRoot,
        mediaPath: p,
      });
      const stat = await fs.stat(resolved.absPath);
      if (stat.size <= 0 || stat.size > maxBytes) {
        continue;
      }
      results.push({
        path: resolved.relPath,
        fileName: path.basename(resolved.relPath) || "file",
        contentType: sniffContentType(resolved.relPath),
        sizeBytes: stat.size,
      });
    } catch {
      // Ignore individual failures; don't fail the whole task.
    }
  }

  return results;
}

