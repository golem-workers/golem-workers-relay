export class QueueClosedError extends Error {
  constructor() {
    super("Queue is closed");
  }
}

export class QueueFullError extends Error {
  readonly maxQueue: number;

  constructor(maxQueue: number) {
    super(`Queue is full (max ${maxQueue})`);
    this.maxQueue = maxQueue;
  }
}

type QueueOptions<T> = {
  concurrency: number;
  maxQueue: number;
  processor: (item: T) => Promise<void>;
  getConcurrencyKey?: (item: T) => string | null;
};

export class InMemoryTaskQueue<T> {
  private readonly queue: T[] = [];
  private inFlight = 0;
  private accepting = true;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly processor: (item: T) => Promise<void>;
  private readonly getConcurrencyKey?: (item: T) => string | null;
  private readonly activeConcurrencyKeys = new Set<string>();

  constructor(opts: QueueOptions<T>) {
    this.concurrency = Math.max(1, Math.trunc(opts.concurrency));
    this.maxQueue = Math.max(1, Math.trunc(opts.maxQueue));
    this.processor = opts.processor;
    this.getConcurrencyKey = opts.getConcurrencyKey;
  }

  enqueue(item: T): void {
    if (!this.accepting) {
      throw new QueueClosedError();
    }
    if (this.queue.length >= this.maxQueue) {
      throw new QueueFullError(this.maxQueue);
    }
    this.queue.push(item);
    this.pump();
  }

  removeQueued(predicate: (item: T) => boolean): T[] {
    const removed: T[] = [];
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item !== undefined && predicate(item)) {
        removed.push(item);
        this.queue.splice(index, 1);
      }
    }
    removed.reverse();
    return removed;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  getState(): { queueLength: number; inFlight: number; accepting: boolean; maxQueue: number } {
    return {
      queueLength: this.queue.length,
      inFlight: this.inFlight,
      accepting: this.accepting,
      maxQueue: this.maxQueue,
    };
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (this.inFlight <= 0 && this.queue.length <= 0) {
        return true;
      }
      await sleep(100);
    }
    return this.inFlight <= 0 && this.queue.length <= 0;
  }

  private pump(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((item) => {
        const key = this.getConcurrencyKey?.(item) ?? null;
        return key === null || !this.activeConcurrencyKeys.has(key);
      });
      if (nextIndex < 0) return;
      const [next] = this.queue.splice(nextIndex, 1);
      if (!next) return;
      const concurrencyKey = this.getConcurrencyKey?.(next) ?? null;
      if (concurrencyKey !== null) {
        this.activeConcurrencyKeys.add(concurrencyKey);
      }
      this.inFlight += 1;
      void this.processor(next).finally(() => {
        if (concurrencyKey !== null) {
          this.activeConcurrencyKeys.delete(concurrencyKey);
        }
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pump();
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
