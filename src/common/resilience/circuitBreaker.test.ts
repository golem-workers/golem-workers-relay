import { describe, expect, it } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError } from "./circuitBreaker.js";

describe("CircuitBreaker", () => {
  it("opens after consecutive failures and blocks calls", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openForMs: 2000 });

    await expect(breaker.execute(() => Promise.reject(new Error("fail-1")))).rejects.toThrow("fail-1");
    await expect(breaker.execute(() => Promise.reject(new Error("fail-2")))).rejects.toThrow("fail-2");
    await expect(breaker.execute(() => Promise.resolve("ok"))).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it("moves to half-open and closes on success after timeout", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openForMs: 50 });

    await expect(breaker.execute(() => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    await expect(breaker.execute(() => Promise.resolve("ok"))).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    await sleep(Math.max(80, breaker.getState().retryAfterMs + 20));
    await expect(breaker.execute(() => Promise.resolve("recovered"))).resolves.toBe("recovered");
    expect(breaker.getState().state).toBe("closed");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
