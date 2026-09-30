import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { restoreReplyDeliveryMetadata } from "./replyDeliveryMetadata.js";
import { collectTranscriptArtifacts } from "./mediaDirectives.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(compressed = false, storedRunId = "run-current", storedSessionKey = "agent:main:tg:test") {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-sqlite-media-"));
  roots.push(stateDir);
  const agentDir = path.join(stateDir, "agents/main/agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, "workspace"));
  const mediaUrls = [1, 2, 3].map((i) => path.join(stateDir, `workspace/proof-${i}.md`));
  await Promise.all(mediaUrls.map((p, i) => fs.writeFile(p, `FILE_INDEX=${i + 1}`)));
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec(`CREATE TABLE session_windows (session_id TEXT, session_key TEXT);
    CREATE TABLE transcript_event_identities (session_id TEXT, seq INTEGER, event_id TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, event_utf8_bytes INTEGER);`);
  db.prepare("INSERT INTO session_windows VALUES (?, ?)").run("session-current", storedSessionKey);
  db.prepare("INSERT INTO transcript_event_identities VALUES (?, ?, ?)").run("session-current", 7, "reply-current");
  const raw = JSON.stringify({ id: "reply-current", message: { role: "assistant",
    content: [{ type: "text", text: "Files ready." }], __openclaw: { runId: storedRunId },
    openclawDelivery: { mediaUrls } } });
  db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)").run("session-current", 7,
    compressed ? null : raw, compressed ? zstdCompressSync(raw) : null, Buffer.byteLength(raw));
  db.close();
  const message = { role: "assistant", __openclaw: { id: "reply-current", runId: "run-current" },
    content: [{ type: "text", text: "Files ready." },
      ...mediaUrls.map((p) => ({ type: "attachment_error", attachment: { code: "delivery-failed", label: path.basename(p) } }))] };
  return { stateDir, message, sessionKey: "tg:test", runId: "run-current" };
}

describe("SQLite reply delivery metadata", () => {
  it.each([false, true])("delivers all three files from the exact canonical reply (compressed=%s)", async (compressed) => {
    const input = await fixture(compressed);
    const message = await restoreReplyDeliveryMetadata(input);
    const result = await collectTranscriptArtifacts({ message, opts: { stateDir: input.stateDir } });
    expect(result.artifacts.map((a) => a.fileName)).toEqual(["proof-1.md", "proof-2.md", "proof-3.md"]);
    expect(result.requestedCount).toBe(3);
    expect(result.recoveredCount).toBe(0);
    expect(result.unresolved).toEqual([]);
    expect(result.usedStructuredArtifacts).toBe(true);
  });
  it("does not recover files from display error labels alone", async () => {
    const input = await fixture();
    const result = await collectTranscriptArtifacts({ message: input.message, opts: { stateDir: input.stateDir } });
    expect(result.requestedCount).toBe(0);
  });
  it("rejects another run's stored reply", async () => {
    await expect(restoreReplyDeliveryMetadata(await fixture(false, "run-old"))).rejects.toThrow("identity mismatch");
  });
  it("rejects another session's event", async () => {
    await expect(restoreReplyDeliveryMetadata(await fixture(false, "run-current", "agent:main:tg:other"))).rejects.toThrow("missing or ambiguous");
  });
  it("leaves legacy replies without a SQLite store unchanged", async () => {
    const input = await fixture();
    await fs.rm(path.join(input.stateDir, "agents"), { recursive: true });
    expect(await restoreReplyDeliveryMetadata(input)).toBe(input.message);
  });
});
