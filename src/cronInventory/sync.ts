import { logger } from "../logger.js";
import type { CronInventoryAck, CronInventorySnapshot } from "./contract.js";
import type { CronInventoryCollector } from "./collector.js";
import {
  type CronInventoryState,
  type CronInventoryStateStore,
  withPendingSnapshot,
} from "./stateStore.js";

type BackendLike = {
  submitCronInventory(input: {
    snapshot: CronInventorySnapshot;
  }): Promise<CronInventoryAck>;
};

export type CronInventorySync = {
  start(): Promise<void>;
  stop(): void;
  runOnce(input?: { force?: boolean; requestId?: string }): Promise<CronInventorySnapshot | null>;
  getState(): {
    running: boolean;
    retryAttempt: number;
    lastAcknowledgedHash: string | null;
    pendingHash: string | null;
    skippedTicks: number;
  };
};

export function createCronInventorySync(input: {
  collector: CronInventoryCollector;
  backend: BackendLike;
  store: CronInventoryStateStore;
  intervalMs: number;
  initialJitterMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  random?: () => number;
}): CronInventorySync {
  const random = input.random ?? Math.random;
  let state: CronInventoryState | null = null;
  let currentRun: Promise<CronInventorySnapshot | null> | null = null;
  let sendPromise: Promise<CronInventoryAck | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let stopped = false;
  let skippedTicks = 0;

  const loadState = async () => {
    state ??= await input.store.load();
    return state;
  };

  const saveState = async (next: CronInventoryState) => {
    await input.store.save(next);
    state = next;
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    const exponential = Math.min(
      input.retryMaxMs,
      input.retryBaseMs * 2 ** Math.min(retryAttempt, 16),
    );
    const delayMs = Math.max(1, Math.round(exponential * (0.75 + random() * 0.5)));
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drainPending();
    }, delayMs);
    retryTimer.unref?.();
    logger.warn(
      { event: "cron.inventory.retry", retryAttempt, delayMs },
      "Cron inventory retry scheduled",
    );
  };

  const drainPending = async (): Promise<CronInventoryAck | null> => {
    if (sendPromise) return sendPromise;
    sendPromise = (async () => {
      const current = await loadState();
      const pending = current.pendingSnapshot;
      if (!pending || stopped) return null;
      try {
        const ack = await input.backend.submitCronInventory({ snapshot: pending });
        if (ack.acceptedHash !== pending.configHash) {
          throw new Error("Backend cron inventory ACK hash mismatch");
        }
        const latest = await loadState();
        if (latest.pendingSnapshot?.configHash !== pending.configHash) {
          return ack;
        }
        const acknowledged =
          pending.collectionStatus === "FAILED"
            ? withPendingSnapshot(latest, null)
            : {
                ...withPendingSnapshot(latest, null),
                lastAcknowledgedHash: ack.acceptedHash,
                lastAcknowledgedAt: ack.receivedAt,
              };
        await saveState(acknowledged);
        retryAttempt = 0;
        logger.info(
          {
            event: "cron.inventory.acknowledged",
            configHash: ack.acceptedHash,
            inventoryVersion: ack.inventoryVersion,
            collectionStatus: pending.collectionStatus,
            requestId: pending.requestId ?? null,
          },
          "Cron inventory acknowledged",
        );
        return ack;
      } catch (error) {
        logger.warn(
          {
            event: "cron.inventory.push_failed",
            configHash: pending.configHash,
            requestId: pending.requestId ?? null,
            error: error instanceof Error ? error.message : String(error),
          },
          "Cron inventory push failed",
        );
        scheduleRetry();
        return null;
      }
    })().finally(() => {
      sendPromise = null;
      if (!stopped && !retryTimer && state?.pendingSnapshot) {
        queueMicrotask(() => void drainPending());
      }
    });
    return sendPromise;
  };

  const executeCollection = async (options?: {
    force?: boolean;
    requestId?: string;
  }): Promise<CronInventorySnapshot | null> => {
    const startedAt = Date.now();
    const snapshot = await input.collector.collect({ requestId: options?.requestId });
    const current = await loadState();
    const unchanged =
      snapshot.collectionStatus !== "FAILED" &&
      snapshot.configHash === current.lastAcknowledgedHash;
    if (!options?.force && unchanged && !current.pendingSnapshot) {
      logger.debug(
        {
          event: "cron.inventory.unchanged",
          configHash: snapshot.configHash,
          durationMs: Date.now() - startedAt,
        },
        "Cron inventory unchanged",
      );
      return snapshot;
    }
    const existing = current.pendingSnapshot;
    const shouldReplace =
      options?.force === true ||
      !existing ||
      existing.configHash !== snapshot.configHash ||
      existing.collectionStatus !== snapshot.collectionStatus;
    if (shouldReplace) {
      await saveState(withPendingSnapshot(current, snapshot));
    }
    await drainPending();
    return snapshot;
  };

  const runOnce = async (options?: {
    force?: boolean;
    requestId?: string;
  }): Promise<CronInventorySnapshot | null> => {
    if (currentRun) {
      if (!options?.force) {
        skippedTicks += 1;
        logger.warn(
          { event: "cron.inventory.tick_skipped", skippedTicks },
          "Cron inventory tick skipped because collection is running",
        );
        return null;
      }
      await currentRun;
    }
    currentRun = executeCollection(options).finally(() => {
      currentRun = null;
    });
    return currentRun;
  };

  const scheduleNextTick = (delayMs = input.intervalMs) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce()
        .catch((error) => {
          logger.warn(
            {
              event: "cron.inventory.collection_failed",
              error: error instanceof Error ? error.message : String(error),
            },
            "Cron inventory collection failed",
          );
        })
        .finally(() => scheduleNextTick());
    }, delayMs);
    timer.unref?.();
  };

  return {
    async start() {
      stopped = false;
      const current = await loadState();
      if (current.pendingSnapshot) void drainPending();
      const jitter = Math.round(random() * input.initialJitterMs);
      scheduleNextTick(jitter);
      logger.info(
        {
          event: "cron.inventory.started",
          intervalMs: input.intervalMs,
          initialJitterMs: jitter,
          pendingHash: current.pendingSnapshot?.configHash ?? null,
          lastAcknowledgedHash: current.lastAcknowledgedHash,
        },
        "Cron inventory synchronization started",
      );
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (retryTimer) clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
    runOnce,
    getState() {
      return {
        running: currentRun !== null,
        retryAttempt,
        lastAcknowledgedHash: state?.lastAcknowledgedHash ?? null,
        pendingHash: state?.pendingSnapshot?.configHash ?? null,
        skippedTicks,
      };
    },
  };
}
