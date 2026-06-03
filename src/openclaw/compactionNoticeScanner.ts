import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

export type CompactionNoticeScanStart = {
  sessionFile: string | null;
  lineCount: number;
};

export type CompactionNoticeCandidate = {
  fingerprint: string;
  sessionFile: string;
  lineIndex: number;
  text: string;
  timestampMs?: number;
};

type DeliveredStore = {
  records: Record<string, { deliveredAtMs: number }>;
};

export function captureCompactionNoticeScanStart(input: {
  sessionKey: string;
  stateDir?: string;
}): CompactionNoticeScanStart {
  const sessionFile = resolveSessionFileSync(input);
  if (!sessionFile) return { sessionFile: null, lineCount: 0 };
  return {
    sessionFile,
    lineCount: readTranscriptLineCountSync(sessionFile),
  };
}

export async function readNewCompactionNoticeCandidates(input: {
  sessionKey: string;
  scanStart: CompactionNoticeScanStart;
  stateDir?: string;
  maxCandidates?: number;
}): Promise<CompactionNoticeCandidate[]> {
  const stateDir = input.stateDir ?? resolveOpenclawStateDir();
  const files = new Map<string, number>();
  if (input.scanStart.sessionFile) {
    files.set(input.scanStart.sessionFile, Math.max(0, Math.trunc(input.scanStart.lineCount)));
  }
  const currentSessionFile = await resolveSessionFile({ sessionKey: input.sessionKey, stateDir });
  if (currentSessionFile && !files.has(currentSessionFile)) {
    files.set(currentSessionFile, 0);
  }
  if (files.size === 0) return [];

  const delivered = await loadDeliveredStore(stateDir);
  const candidates: CompactionNoticeCandidate[] = [];
  for (const [sessionFile, startLine] of files) {
    const fileCandidates = await readCompactionNoticeCandidatesFromFile({
      sessionKey: input.sessionKey,
      sessionFile,
      startLine,
    });
    for (const candidate of fileCandidates) {
      if (!delivered.records[candidate.fingerprint]) {
        candidates.push(candidate);
      }
    }
  }
  candidates.sort((a, b) => {
    const timeDelta = (a.timestampMs ?? 0) - (b.timestampMs ?? 0);
    return timeDelta === 0 ? a.lineIndex - b.lineIndex : timeDelta;
  });
  return candidates.slice(0, Math.max(1, Math.trunc(input.maxCandidates ?? 5)));
}

export async function markCompactionNoticeCandidatesDelivered(input: {
  candidates: CompactionNoticeCandidate[];
  stateDir?: string;
  deliveredAtMs?: number;
}): Promise<void> {
  if (input.candidates.length === 0) return;
  const stateDir = input.stateDir ?? resolveOpenclawStateDir();
  const store = await loadDeliveredStore(stateDir);
  const deliveredAtMs = Math.max(0, Math.trunc(input.deliveredAtMs ?? Date.now()));
  for (const candidate of input.candidates) {
    store.records[candidate.fingerprint] = { deliveredAtMs };
  }
  await saveDeliveredStore(stateDir, store);
}

async function resolveSessionFile(input: { sessionKey: string; stateDir?: string }): Promise<string | null> {
  const stateDir = input.stateDir ?? resolveOpenclawStateDir();
  const sessionsMapFile = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const raw = await fs.readFile(sessionsMapFile, "utf8").catch(() => "");
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const entry = parsed[`agent:main:${input.sessionKey}`];
  if (!isPlainObject(entry)) return null;
  const rawSessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (!rawSessionFile) return null;
  return path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(stateDir, "agents", "main", "sessions", rawSessionFile);
}

function resolveSessionFileSync(input: { sessionKey: string; stateDir?: string }): string | null {
  const stateDir = input.stateDir ?? resolveOpenclawStateDir();
  const sessionsMapFile = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  let raw = "";
  try {
    raw = fsSync.readFileSync(sessionsMapFile, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const entry = parsed[`agent:main:${input.sessionKey}`];
  if (!isPlainObject(entry)) return null;
  const rawSessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile.trim() : "";
  if (!rawSessionFile) return null;
  return path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(stateDir, "agents", "main", "sessions", rawSessionFile);
}

function readTranscriptLineCountSync(sessionFile: string): number {
  let raw = "";
  try {
    raw = fsSync.readFileSync(sessionFile, "utf8");
  } catch {
    return 0;
  }
  if (!raw.trim()) return 0;
  return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function readCompactionNoticeCandidatesFromFile(input: {
  sessionKey: string;
  sessionFile: string;
  startLine: number;
}): Promise<CompactionNoticeCandidate[]> {
  const raw = await fs.readFile(input.sessionFile, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const candidates: CompactionNoticeCandidate[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index < input.startLine || !line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isPlainObject(parsed) || parsed.type !== "message") return;
    const message = isPlainObject(parsed.message) ? parsed.message : null;
    if (!message) return;
    const text = extractTextFromMessage(message).trim();
    if (!isCompactionNoticeMarker(text)) return;
    candidates.push({
      fingerprint: fingerprintCompactionNotice({
        sessionKey: input.sessionKey,
        sessionFile: input.sessionFile,
        lineIndex: index,
        text,
      }),
      sessionFile: input.sessionFile,
      lineIndex: index,
      text,
      ...(extractTimestampMs(parsed, message) ? { timestampMs: extractTimestampMs(parsed, message) } : {}),
    });
  });
  return candidates;
}

function isCompactionNoticeMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("session was just compacted") ||
    normalized.includes("post-compaction context refresh") ||
    normalized.includes("context compacted")
  );
}

function extractTextFromMessage(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isPlainObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function extractTimestampMs(record: Record<string, unknown>, message: Record<string, unknown>): number | undefined {
  return parseTimestampMs(message.timestamp) ?? parseTimestampMs(record.timestamp);
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fingerprintCompactionNotice(input: {
  sessionKey: string;
  sessionFile: string;
  lineIndex: number;
  text: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(input.sessionKey)
    .update("\0")
    .update(input.sessionFile)
    .update("\0")
    .update(String(input.lineIndex))
    .update("\0")
    .update(input.text.slice(0, 500))
    .digest("hex");
}

async function loadDeliveredStore(stateDir: string): Promise<DeliveredStore> {
  const raw = await fs.readFile(resolveDeliveredStorePath(stateDir), "utf8").catch(() => "");
  if (!raw.trim()) return { records: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed) || !isPlainObject(parsed.records)) return { records: {} };
    const records: DeliveredStore["records"] = {};
    for (const [key, value] of Object.entries(parsed.records)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !isPlainObject(value)) continue;
      const deliveredAtMs = typeof value.deliveredAtMs === "number" ? value.deliveredAtMs : null;
      if (deliveredAtMs === null || !Number.isFinite(deliveredAtMs)) continue;
      records[key] = { deliveredAtMs };
    }
    return { records };
  } catch {
    return { records: {} };
  }
}

async function saveDeliveredStore(stateDir: string, store: DeliveredStore): Promise<void> {
  const filePath = resolveDeliveredStorePath(stateDir);
  const entries = Object.entries(store.records).sort(([, a], [, b]) => b.deliveredAtMs - a.deliveredAtMs);
  const records = Object.fromEntries(entries.slice(0, 5_000));
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

function resolveDeliveredStorePath(stateDir: string): string {
  return path.join(stateDir, "agents", "main", "golem-workers", "relay-compaction-notice-index.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
