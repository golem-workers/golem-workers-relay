import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** History is a display projection: it intentionally omits local delivery URLs.
 * Read only the exact selected assistant event, never infer files from display labels.
 * Older OpenClaw installs without the SQLite store keep their existing message format.
 */
export async function restoreReplyDeliveryMetadata(input: {
  message: unknown;
  sessionKey: string;
  runId: string;
  stateDir?: string;
}): Promise<unknown> {
  const message = record(input.message);
  const identity = record(message?.__openclaw);
  if (!message || message.role !== "assistant" || typeof identity?.id !== "string" ||
      identity.runId !== input.runId) return input.message;
  const databasePath = path.join(input.stateDir ?? resolveOpenclawStateDir(process.env),
    "agents", "main", "agent", "openclaw-agent.sqlite");
  try {
    await fs.access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return input.message;
    throw error;
  }
  // Lazy import preserves support for legacy Node/OpenClaw installations without SQLite.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const sessionKey = input.sessionKey.startsWith("agent:main:")
      ? input.sessionKey : `agent:main:${input.sessionKey}`;
    const row = db.prepare(`
      SELECT e.event_json, e.event_zstd, e.event_utf8_bytes
      FROM transcript_event_identities i
      JOIN transcript_events e ON e.session_id = i.session_id AND e.seq = i.seq
      JOIN session_windows s ON s.session_id = i.session_id
      WHERE i.event_id = ? AND s.session_key = ?
      LIMIT 2
    `).all(identity.id, sessionKey);
    if (row.length !== 1) throw new Error("Reply delivery metadata: selected transcript event is missing or ambiguous");
    const event = row[0];
    let raw = event.event_json;
    if (raw === null && event.event_zstd instanceof Uint8Array) {
      const bytes = event.event_utf8_bytes;
      if (typeof bytes !== "number" || bytes < 1 || bytes > 4_194_304) {
        throw new Error("Reply delivery metadata: invalid compressed event size");
      }
      const { zstdDecompressSync } = await import("node:zlib");
      const decoded = zstdDecompressSync(event.event_zstd, { maxOutputLength: bytes });
      if (decoded.length !== bytes) throw new Error("Reply delivery metadata: compressed event size mismatch");
      raw = decoded.toString("utf8");
    }
    if (typeof raw !== "string") throw new Error("Reply delivery metadata: invalid transcript event");
    const envelope = record(JSON.parse(raw));
    const stored = record(envelope?.message);
    if (envelope?.id !== identity.id || stored?.role !== "assistant" ||
        record(stored.__openclaw)?.runId !== input.runId) {
      throw new Error("Reply delivery metadata: transcript identity mismatch");
    }
    const delivery = record(stored.openclawDelivery);
    if (!delivery) return input.message;
    return { ...message, openclawDelivery: delivery };
  } finally {
    db.close();
  }
}
