import fs from "node:fs/promises";
import path from "node:path";

export type TranscriptMediaFile = {
  /** The MEDIA: path as found in the transcript (relative). */
  path: string;
  fileName: string;
  contentType: string;
  dataB64: string;
  sizeBytes: number;
};

export type CollectTranscriptMediaOpts = {
  stateDir?: string; // defaults to $OPENCLAW_STATE_DIR or ~/.openclaw
  maxFiles?: number;
  maxBytes?: number;
};

function resolveDefaultStateDir(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) return env;
  // OpenClaw defaults to ~/.openclaw; on the agent server we run as root.
  return path.join(process.env.HOME || "/root", ".openclaw");
}

function resolveStatePaths(stateDir: string) {
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  return {
    sessionsMapFile: path.join(sessionsDir, "sessions.json"),
    workspaceRoot: path.join(stateDir, "workspace"),
  };
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

async function resolveSessionFileForSessionKey(params: {
  sessionsMapFile: string;
  sessionKey: string;
}): Promise<string | null> {
  const raw = await fs.readFile(params.sessionsMapFile, "utf8").catch(() => "");
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!looksLikePlainObject(parsed)) return null;

  const exactKey = `agent:main:${params.sessionKey}`;
  const exact = parsed[exactKey];
  if (looksLikePlainObject(exact) && typeof exact.sessionFile === "string" && exact.sessionFile.trim()) {
    return exact.sessionFile.trim();
  }

  // Fallback: find a mapping key that ends with `:${sessionKey}`.
  const suffix = `:${params.sessionKey}`;
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.endsWith(suffix)) continue;
    if (looksLikePlainObject(v) && typeof v.sessionFile === "string" && v.sessionFile.trim()) {
      return v.sessionFile.trim();
    }
  }
  return null;
}

function extractAssistantTextFromTranscriptLine(obj: unknown): string | null {
  if (!looksLikePlainObject(obj)) return null;
  if (obj.type !== "message") return null;
  const msg = (obj as { message?: unknown }).message;
  if (!looksLikePlainObject(msg)) return null;
  if (msg.role !== "assistant") return null;
  const content = msg.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((p) => (looksLikePlainObject(p) && p.type === "text" && typeof p.text === "string" ? p.text : null))
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  if (parts.length === 0) return null;
  return parts.join("\n");
}

async function readLatestAssistantMediaPathsFromTranscript(sessionFile: string): Promise<string[]> {
  const raw = await fs.readFile(sessionFile, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  // Walk backwards and return the most recent assistant message that contains MEDIA: directives.
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const text = extractAssistantTextFromTranscriptLine(obj);
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

async function resolveMediaFile(params: {
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
  sessionKey: string;
  opts?: CollectTranscriptMediaOpts;
}): Promise<TranscriptMediaFile[]> {
  const stateDir = params.opts?.stateDir ?? resolveDefaultStateDir();
  const maxFiles = Math.max(0, Math.min(10, Math.trunc(params.opts?.maxFiles ?? 4)));
  const maxBytes = Math.max(1, Math.trunc(params.opts?.maxBytes ?? 5_000_000));
  if (maxFiles === 0) return [];

  const { sessionsMapFile, workspaceRoot } = resolveStatePaths(stateDir);
  const sessionFile = await resolveSessionFileForSessionKey({
    sessionsMapFile,
    sessionKey: params.sessionKey,
  });
  if (!sessionFile) return [];

  const mediaPaths = await readLatestAssistantMediaPathsFromTranscript(sessionFile);
  if (mediaPaths.length === 0) return [];

  const results: TranscriptMediaFile[] = [];
  for (const p of mediaPaths) {
    if (results.length >= maxFiles) break;
    try {
      const resolved = await resolveMediaFile({
        stateDir,
        workspaceRoot,
        mediaPath: p,
      });
      const buf = await fs.readFile(resolved.absPath);
      if (buf.byteLength <= 0 || buf.byteLength > maxBytes) {
        continue;
      }
      results.push({
        path: resolved.relPath,
        fileName: path.basename(resolved.relPath) || "file",
        contentType: sniffContentType(resolved.relPath),
        dataB64: buf.toString("base64"),
        sizeBytes: buf.byteLength,
      });
    } catch {
      // Ignore individual failures; don't fail the whole task.
    }
  }

  return results;
}

