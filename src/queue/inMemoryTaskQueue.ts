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
};

export class InMemoryTaskQueue<T> {
  private readonly queue: T[] = [];
  private inFlight = 0;
  private accepting = true;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly processor: (item: T) => Promise<void>;

  constructor(opts: QueueOptions<T>) {
    this.concurrency = Math.max(1, Math.trunc(opts.concurrency));
    this.maxQueue = Math.max(1, Math.trunc(opts.maxQueue));
    this.processor = opts.processor;
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
      const next = this.queue.shift();
      if (!next) return;
      this.inFlight += 1;
      void this.processor(next).finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pump();
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
