import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import type { InboundPushMessage } from "../backend/types.js";

export type DurableInFlightChatTask = {
  schemaVersion: 1;
  backendMessageId: string;
  relayMessageId: string;
  relayInstanceId: string;
  sessionKey: string;
  messageText: string;
  context?: unknown;
  media?: Extract<InboundPushMessage["input"], { kind: "chat" }>["media"];
  runId?: string;
  requestMessage?: unknown;
  startedAtMs: number;
  updatedAtMs: number;
};

export type InFlightTaskStore = {
  upsert(record: DurableInFlightChatTask): Promise<void>;
  updateRun(input: {
    backendMessageId: string;
    runId: string;
    requestMessage: unknown;
    updatedAtMs: number;
  }): Promise<void>;
  remove(backendMessageId: string): Promise<void>;
  list(): Promise<DurableInFlightChatTask[]>;
};

export function createInFlightTaskStore(input?: { stateDir?: string }): InFlightTaskStore {
  const dir = path.join(input?.stateDir ?? resolveOpenclawStateDir(process.env), "relay", "in-flight");

  const fileFor = (backendMessageId: string): string => {
    const safeId = backendMessageId.replace(/[^A-Za-z0-9_.:-]/g, "_");
    return path.join(dir, `${safeId}.json`);
  };

  const writeAtomic = async (file: string, record: DurableInFlightChatTask): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  };

  return {
    async upsert(record) {
      await writeAtomic(fileFor(record.backendMessageId), record);
    },

    async updateRun(input) {
      const file = fileFor(input.backendMessageId);
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw.trim()) return;
      const current = parseRecord(raw);
      if (!current) return;
      await writeAtomic(file, {
        ...current,
        runId: input.runId,
        requestMessage: input.requestMessage,
        updatedAtMs: input.updatedAtMs,
      });
    },

    async remove(backendMessageId) {
      await fs.rm(fileFor(backendMessageId), { force: true }).catch(() => undefined);
    },

    async list() {
      const entries = await fs.readdir(dir).catch(() => []);
      const records: DurableInFlightChatTask[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, entry), "utf8").catch(() => "");
        const parsed = parseRecord(raw);
        if (parsed) records.push(parsed);
      }
      records.sort((a, b) => a.startedAtMs - b.startedAtMs);
      return records;
    },
  };
}

function parseRecord(raw: string): DurableInFlightChatTask | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<DurableInFlightChatTask>;
    if (
      record.schemaVersion !== 1 ||
      typeof record.backendMessageId !== "string" ||
      typeof record.relayMessageId !== "string" ||
      typeof record.relayInstanceId !== "string" ||
      typeof record.sessionKey !== "string" ||
      typeof record.messageText !== "string" ||
      typeof record.startedAtMs !== "number" ||
      typeof record.updatedAtMs !== "number"
    ) {
      return null;
    }
    return record as DurableInFlightChatTask;
  } catch {
    return null;
  }
}
