import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { cronInventorySnapshotSchema, type CronInventorySnapshot } from "./contract.js";

const cronInventoryStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastAcknowledgedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    lastAcknowledgedAt: z.string().datetime({ offset: true }).nullable(),
    pendingSnapshot: cronInventorySnapshotSchema.nullable(),
  })
  .strict();

export type CronInventoryState = z.infer<typeof cronInventoryStateSchema>;

export type CronInventoryStateStore = {
  load(): Promise<CronInventoryState>;
  save(state: CronInventoryState): Promise<void>;
};

export function createCronInventoryStateStore(input?: {
  stateDir?: string;
}): CronInventoryStateStore {
  const directory = path.join(
    input?.stateDir ?? resolveOpenclawStateDir(process.env),
    "relay",
    "cron-inventory",
  );
  const file = path.join(directory, "state.json");
  return {
    async load() {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw.trim()) return emptyState();
      try {
        const parsed = cronInventoryStateSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? parsed.data : emptyState();
      } catch {
        return emptyState();
      }
    },
    async save(candidate) {
      const state = cronInventoryStateSchema.parse(candidate);
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const directoryHandle = await fs.open(directory, "r").catch(() => null);
      if (directoryHandle) {
        try {
          await directoryHandle.sync().catch(() => undefined);
        } finally {
          await directoryHandle.close();
        }
      }
    },
  };
}

export function withPendingSnapshot(
  state: CronInventoryState,
  pendingSnapshot: CronInventorySnapshot | null,
): CronInventoryState {
  return cronInventoryStateSchema.parse({ ...state, pendingSnapshot });
}

function emptyState(): CronInventoryState {
  return {
    schemaVersion: 1,
    lastAcknowledgedHash: null,
    lastAcknowledgedAt: null,
    pendingSnapshot: null,
  };
}
