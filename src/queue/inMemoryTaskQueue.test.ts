import { describe, expect, it } from "vitest";
import { InMemoryTaskQueue, QueueClosedError, QueueFullError } from "./inMemoryTaskQueue.js";

describe("InMemoryTaskQueue", () => {
  it("processes queued items and drains", async () => {
    const processed: number[] = [];
    const queue = new InMemoryTaskQueue<number>({
      concurrency: 2,
      maxQueue: 10,
      processor: async (item) => {
        await sleep(5);
        processed.push(item);
      },
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    const drained = await queue.drain(1000);

    expect(drained).toBe(true);
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(queue.getState().inFlight).toBe(0);
    expect(queue.getState().queueLength).toBe(0);
  });

  it("throws on full or closed queue", () => {
    let release: (() => void) | null = null;
    const queue = new InMemoryTaskQueue<number>({
      concurrency: 1,
      maxQueue: 1,
      processor: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    queue.enqueue(1);
    queue.enqueue(2);
    expect(() => queue.enqueue(3)).toThrowError(QueueFullError);

    queue.stopAccepting();
    expect(() => queue.enqueue(4)).toThrowError(QueueClosedError);
    release?.();
  });

  it("removes matching queued items without touching the active task", async () => {
    let release: (() => void) | null = null;
    const processed: number[] = [];
    const queue = new InMemoryTaskQueue<number>({
      concurrency: 1,
      maxQueue: 10,
      processor: async (item) => {
        processed.push(item);
        if (item === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
    });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);

    const removed = queue.removeQueued((item) => item % 2 === 0);
    expect(removed).toEqual([2, 4]);
    expect(queue.getState()).toMatchObject({ inFlight: 1, queueLength: 1 });

    release?.();
    const drained = await queue.drain(1000);
    expect(drained).toBe(true);
    expect(processed).toEqual([1, 3]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
