import { logger } from "../logger.js";
import {
  type PullResponse,
  pullResponseSchema,
  type TaskResultRequest,
  acceptedResponseSchema,
} from "./types.js";

export type BackendClientOptions = {
  baseUrl: string;
  relayToken: string;
};

export class BackendClient {
  constructor(private readonly opts: BackendClientOptions) {}

  async pull(input: { relayInstanceId: string; maxTasks: number; waitSeconds: number }): Promise<PullResponse> {
    const url = `${this.opts.baseUrl}/api/v1/relays/pull`;
    const timeoutMs = input.waitSeconds * 1000 + 15_000;
    const res = await retry(
      () => postJson(url, this.opts.relayToken, input, timeoutMs),
      { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "pull" }
    );
    const parsed = pullResponseSchema.parse(res);
    return parsed;
  }

  async submitResult(input: { taskId: string; body: TaskResultRequest }): Promise<{ accepted: true }> {
    const url = `${this.opts.baseUrl}/api/v1/relays/tasks/${encodeURIComponent(input.taskId)}/result`;
    const timeoutMs = 15_000;
    const res = await retry(
      () => postJson(url, this.opts.relayToken, input.body, timeoutMs),
      { attempts: 5, minDelayMs: 500, maxDelayMs: 10_000, label: "submitResult" }
    );
    const parsed = acceptedResponseSchema.parse(res);
    if (!parsed.accepted) {
      throw new Error("Backend rejected relay result");
    }
    return { accepted: true };
  }
}

async function postJson(url: string, token: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await resp.text();
    const json = text ? (JSON.parse(text) as unknown) : null;

    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, "Backend returned non-2xx for relay request");
      const err = new Error(`Backend HTTP ${resp.status}`);
      (err as Error & { status?: number }).status = resp.status;
      throw err;
    }
    return json;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Backend request timed out");
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; minDelayMs: number; maxDelayMs: number; label: string }
): Promise<T> {
  let attempt = 0;
  let delay = opts.minDelayMs;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof Error ? (err as Error & { status?: number }).status : undefined;
      const retryable = status === undefined || (status >= 500 && status <= 599) || status === 429;
      if (!retryable || attempt >= opts.attempts) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const jitter = Math.floor(Math.random() * 250);
      const sleepMs = Math.min(opts.maxDelayMs, delay) + jitter;
      logger.warn({ attempt, sleepMs, label: opts.label, status: status ?? null }, "Retrying backend request");
      await new Promise((r) => setTimeout(r, sleepMs));
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.8));
    }
  }
}

