export function computeBackoffMs(schedule: number[], attemptIndex: number, jitterMs: number): number {
  const base = schedule[Math.max(0, Math.min(schedule.length - 1, attemptIndex))] ?? 0;
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return Math.max(0, Math.trunc(base) + jitter);
}

export async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
