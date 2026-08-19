import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import {
  agentLifecycleEventSchema,
  type AgentLifecycleEvent,
} from "./contract.js";

const storedEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    enqueuedAt: z.string().datetime({ offset: true }),
    event: agentLifecycleEventSchema,
  })
  .strict();

export type PendingAgentLifecycleEvent = Readonly<{
  fileName: string;
  enqueuedAt: string;
  event: AgentLifecycleEvent;
}>;

export type AgentLifecycleOutbox = {
  enqueue(event: AgentLifecycleEvent): Promise<PendingAgentLifecycleEvent>;
  list(): Promise<PendingAgentLifecycleEvent[]>;
  acknowledge(entry: PendingAgentLifecycleEvent): Promise<void>;
  quarantine(entry: PendingAgentLifecycleEvent, reason: string): Promise<void>;
};

export function createAgentLifecycleOutbox(input?: {
  stateDir?: string;
  maxPending?: number;
  maxBytes?: number;
  now?: () => Date;
}): AgentLifecycleOutbox {
  const root = path.join(
    input?.stateDir ?? resolveOpenclawStateDir(process.env),
    "relay",
    "agent-lifecycle-outbox",
  );
  const pendingDir = path.join(root, "pending");
  const quarantineDir = path.join(root, "quarantine");
  const maxPending = input?.maxPending ?? 10_000;
  const maxBytes = input?.maxBytes ?? 64 * 1024 * 1024;
  const now = input?.now ?? (() => new Date());

  const ensureDirs = async (): Promise<void> => {
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(quarantineDir, { recursive: true });
  };

  const moveCorrupt = async (fileName: string, reason: string): Promise<void> => {
    const source = path.join(pendingDir, fileName);
    const target = path.join(quarantineDir, `${fileName}.${Date.now()}.corrupt`);
    await fs.rename(source, target).catch(() => undefined);
    await fs
      .writeFile(`${target}.reason.txt`, `${reason}\n`, "utf8")
      .catch(() => undefined);
    await syncDirectory(quarantineDir);
  };

  const list = async (): Promise<PendingAgentLifecycleEvent[]> => {
    await ensureDirs();
    const fileNames = (await fs.readdir(pendingDir))
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
    const pending: PendingAgentLifecycleEvent[] = [];
    for (const fileName of fileNames) {
      const raw = await fs
        .readFile(path.join(pendingDir, fileName), "utf8")
        .catch(() => "");
      const parsed = storedEventSchema.safeParse(safeJson(raw));
      if (!parsed.success) {
        await moveCorrupt(fileName, "invalid lifecycle outbox record");
        continue;
      }
      pending.push({ fileName, ...parsed.data });
    }
    return pending;
  };

  return {
    async enqueue(candidate) {
      const event = agentLifecycleEventSchema.parse(candidate);
      await ensureDirs();
      const existing = (await list()).find(
        (entry) =>
          entry.event.serverId === event.serverId &&
          entry.event.eventId === event.eventId,
      );
      if (existing) {
        if (JSON.stringify(existing.event) !== JSON.stringify(event)) {
          throw new Error("Lifecycle outbox event identity conflict");
        }
        return existing;
      }

      const stats = await Promise.all(
        (await fs.readdir(pendingDir))
          .filter((name) => name.endsWith(".json"))
          .map((name) => fs.stat(path.join(pendingDir, name))),
      );
      const pendingBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
      if (stats.length >= maxPending || pendingBytes >= maxBytes) {
        throw new Error("Agent lifecycle outbox capacity exceeded");
      }

      const enqueuedAt = now().toISOString();
      const digest = createHash("sha256")
        .update(`${event.serverId}\0${event.eventId}`)
        .digest("hex")
        .slice(0, 20);
      const timestamp = String(Date.parse(enqueuedAt)).padStart(13, "0");
      const sequence = String(event.sequence).padStart(16, "0");
      const fileName = `${timestamp}-${sequence}-${digest}.json`;
      const file = path.join(pendingDir, fileName);
      const temporary = path.join(
        pendingDir,
        `.${fileName}.${process.pid}.${randomUUID()}.tmp`,
      );
      const record = storedEventSchema.parse({
        schemaVersion: 1,
        enqueuedAt,
        event,
      });
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      await syncDirectory(pendingDir);
      return { fileName, enqueuedAt, event };
    },

    list,

    async acknowledge(entry) {
      await fs.unlink(path.join(pendingDir, entry.fileName)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      });
      await syncDirectory(pendingDir);
    },

    async quarantine(entry, reason) {
      await ensureDirs();
      const source = path.join(pendingDir, entry.fileName);
      const target = path.join(
        quarantineDir,
        `${entry.fileName}.${Date.now()}.rejected`,
      );
      await fs.rename(source, target);
      await fs.writeFile(`${target}.reason.txt`, `${reason}\n`, "utf8");
      await syncDirectory(quarantineDir);
      await syncDirectory(pendingDir);
    },
  };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
