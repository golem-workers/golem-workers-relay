import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import { z } from "zod";
import { withOwnerFenceLock } from "./ownerFence.js";
import { writeRuntimeAuthPool } from "./runtimeAuthWriter.js";
import {
  assertSubscriptionOnlyConfiguration,
  prepareSubscriptionPool,
  SubscriptionPoolError,
  type SubscriptionPoolMember,
  type SubscriptionPoolState,
} from "./openAiSubscriptionPool.js";

const memberMetadata = z.object({
  accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  profileId: z.string().min(1),
  credentialVersion: z.number().int().positive(),
  enabled: z.boolean(),
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const stateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["pending", "applied"]),
  members: z.array(memberMetadata).max(32),
  managedProfileIds: z.array(z.string().min(1)),
});
export function subscriptionPoolStatePath(configPath: string): string {
  return configPath === "/root/.openclaw/openclaw.json"
    ? "/var/lib/golem-workers/openai-subscription-pool.json"
    : configPath + ".golem-openai-pool.json";
}
export async function readSubscriptionPoolState(
  configPath: string,
): Promise<SubscriptionPoolState | null> {
  try {
    return stateSchema.parse(
      JSON.parse(
        await fs.readFile(subscriptionPoolStatePath(configPath), "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function writeState(
  configPath: string,
  state: SubscriptionPoolState,
): Promise<void> {
  const target = subscriptionPoolStatePath(configPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + "." + randomUUID();
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(state) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  const directory = await fs.open(path.dirname(target), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function assertLegacyAuthMutationAllowed(
  configPath: string,
): Promise<void> {
  if (await readSubscriptionPoolState(configPath))
    throw new SubscriptionPoolError(
      "OPENAI_POOL_SCOPED_OPERATION_REQUIRED",
      "This agent has a subscription pool. Use account-scoped authorization operations, not provider-wide replacement/clear.",
    );
}
/** A pending receipt is a high-water mark, not a successful credential ack.
 * Retrying exactly that snapshot reconciles it; stale operations never undo it. */
export async function syncSubscriptionPool(input: {
  configPath: string;
  revision: number;
  members: SubscriptionPoolMember[];
  refreshRuntimeAuth: () => Promise<void>;
  assertRuntimeGuard: () => Promise<void>;
}): Promise<SubscriptionPoolState> {
  return withOwnerFenceLock(input.configPath, async () => {
    const config = z
      .record(z.string(), z.unknown())
      .parse(JSON5.parse(await fs.readFile(input.configPath, "utf8")));
    await input.assertRuntimeGuard();
    assertSubscriptionOnlyConfiguration(config, process.env, {runScopedFallbacks:true});
    const previous = await readSubscriptionPoolState(input.configPath);
    const next = prepareSubscriptionPool(
      previous,
      input.revision,
      input.members,
    );
    // Durable intent before the first credential effect. A failure remains
    // pending instead of overwriting concurrent refreshed tokens on rollback.
    await writeState(input.configPath, next);
    await writeRuntimeAuthPool({
      configPath: input.configPath,
      state: next,
      members: input.members,
    });
    await input.refreshRuntimeAuth();
    const applied = {
      ...next,
      phase: "applied" as const,
      managedProfileIds: next.members.map((m) => m.profileId),
    };
    await writeState(input.configPath, applied);
    return applied;
  });
}
