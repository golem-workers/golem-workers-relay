export class CircuitBreakerOpenError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Circuit breaker is open");
    this.retryAfterMs = Math.max(0, Math.trunc(retryAfterMs));
  }
}

type CircuitBreakerOptions = {
  failureThreshold: number;
  openForMs: number;
};

type State = "closed" | "open" | "half_open";

export class CircuitBreaker {
  private state: State = "closed";
  private consecutiveFailures = 0;
  private openUntilMs = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.ensureRequestAllowed();
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): { state: State; consecutiveFailures: number; retryAfterMs: number } {
    const retryAfterMs = this.state === "open" ? Math.max(0, this.openUntilMs - Date.now()) : 0;
    return { state: this.state, consecutiveFailures: this.consecutiveFailures, retryAfterMs };
  }

  private ensureRequestAllowed(): void {
    if (this.state !== "open") return;
    const now = Date.now();
    if (now >= this.openUntilMs) {
      this.state = "half_open";
      return;
    }
    throw new CircuitBreakerOpenError(this.openUntilMs - now);
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.openUntilMs = 0;
  }

  private onFailure(): void {
    const threshold = Math.max(1, Math.trunc(this.opts.failureThreshold));
    const openForMs = Math.max(100, Math.trunc(this.opts.openForMs));

    if (this.state === "half_open") {
      this.state = "open";
      this.openUntilMs = Date.now() + openForMs;
      this.consecutiveFailures = threshold;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= threshold) {
      this.state = "open";
      this.openUntilMs = Date.now() + openForMs;
    }
  }
}
