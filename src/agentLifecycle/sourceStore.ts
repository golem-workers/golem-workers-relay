import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { resolveOpenclawStateDir } from "../common/utils/paths.js";

const sourceStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    serverId: z.string().min(1).max(200),
    sourceGeneration: z.string().min(1).max(200),
    registered: z.boolean(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type AgentLifecycleSourceState = z.infer<typeof sourceStateSchema>;

export type AgentLifecycleSourceStore = {
  load(): Promise<AgentLifecycleSourceState | null>;
  save(state: AgentLifecycleSourceState): Promise<void>;
};

export function createAgentLifecycleSourceStore(input?: {
  stateDir?: string;
}): AgentLifecycleSourceStore {
  const directory = path.join(
    input?.stateDir ?? resolveOpenclawStateDir(process.env),
    "relay",
    "agent-lifecycle-source",
  );
  const file = path.join(directory, "current.json");

  return {
    async load() {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      if (!raw.trim()) return null;
      try {
        const parsed = sourceStateSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    async save(candidate) {
      const state = sourceStateSchema.parse(candidate);
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
