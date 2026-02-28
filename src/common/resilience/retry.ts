import { computeBackoffMs, sleep } from "./backoff.js";

type RetryOptions = {
  attempts: number;
  baseDelayMs: number[];
  jitterMs?: number;
  shouldRetry: (error: unknown, attempt: number) => boolean;
  onRetry?: (input: { error: unknown; attempt: number; sleepMs: number }) => void;
};

export async function retryWithBackoff<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.trunc(opts.attempts));
  const jitterMs = Math.max(0, Math.trunc(opts.jitterMs ?? 0));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !opts.shouldRetry(error, attempt)) {
        throw error;
      }
      const sleepMs = computeBackoffMs(opts.baseDelayMs, attempt - 1, jitterMs);
      opts.onRetry?.({ error, attempt, sleepMs });
      await sleep(sleepMs);
    }
  }

  throw new Error("unreachable");
}
