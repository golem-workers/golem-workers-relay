import { logger } from "../logger.js";
import {
  type PullResponse,
  pullResponseSchema,
  type TaskResultRequest,
  type RelayInboundMessageRequest,
  relayInboundMessageRequestSchema,
  acceptedResponseSchema,
} from "./types.js";

const MAX_TIMER_MS = 2_147_483_647;

export type BackendClientOptions = {
  baseUrl: string;
  relayToken: string;
  devLogEnabled?: boolean;
};

export class BackendClient {
  constructor(private readonly opts: BackendClientOptions) {}

  async pull(input: { relayInstanceId: string; maxTasks: number; waitSeconds: number }): Promise<PullResponse> {
    const url = `${this.opts.baseUrl}/api/v1/relays/pull`;
    const rawTimeoutMs = input.waitSeconds * 1000 + 15_000;
    const timeoutMs = Math.min(MAX_TIMER_MS, Math.max(1, Math.trunc(rawTimeoutMs)));
    if (timeoutMs !== rawTimeoutMs) {
      logger.warn(
        { url, waitSeconds: input.waitSeconds, rawTimeoutMs, timeoutMs },
        "Backend pull timeout clamped to Node timer max"
      );
    }
    if (this.opts.devLogEnabled) {
      logger.debug({ url, ...input, timeoutMs }, "Backend pull request");
    }
    let res: unknown;
    try {
      res = await retry(
        () => postJson(url, this.opts.relayToken, input, timeoutMs),
        { attempts: 3, minDelayMs: 500, maxDelayMs: 5000, label: "pull" }
      );
    } catch (err) {
      const nonJson = asNonJsonError(err);
      const status = nonJson?.status;
      // Keep relay loop alive when upstream sends unexpected text/HTML with 2xx.
      if (nonJson && status !== undefined && status >= 200 && status <= 299) {
        logger.warn(
          {
            url,
            status,
            contentType: nonJson.contentType,
            bodyPreview: nonJson.bodyPreview,
          },
          "Backend pull returned non-JSON 2xx response; treating as empty task batch"
        );
        return { tasks: [] };
      }
      throw err;
    }
    const parsed = pullResponseSchema.parse(res);
    if (this.opts.devLogEnabled) {
      logger.debug({ url, tasksCount: parsed.tasks.length }, "Backend pull response");
    }
    return parsed;
  }

  async submitResult(input: { taskId: string; body: TaskResultRequest }): Promise<{ accepted: true }> {
    const url = `${this.opts.baseUrl}/api/v1/relays/tasks/${encodeURIComponent(input.taskId)}/result`;
    const timeoutMs = 15_000;
    if (this.opts.devLogEnabled) {
      logger.debug(
        { url, taskId: input.taskId, outcome: input.body.outcome, attempt: input.body.attempt, leaseId: input.body.leaseId },
        "Backend submitResult request"
      );
    }
    const res = await retry(
      () => postJson(url, this.opts.relayToken, input.body, timeoutMs),
      { attempts: 5, minDelayMs: 500, maxDelayMs: 10_000, label: "submitResult" }
    );
    const parsed = acceptedResponseSchema.parse(res);
    if (!parsed.accepted) {
      throw new Error("Backend rejected relay result");
    }
    if (this.opts.devLogEnabled) {
      logger.debug({ url, taskId: input.taskId, accepted: true }, "Backend submitResult accepted");
    }
    return { accepted: true };
  }

  async submitInboundMessage(input: { body: RelayInboundMessageRequest }): Promise<{ accepted: true }> {
    const url = `${this.opts.baseUrl}/api/v1/relays/messages`;
    const timeoutMs = 15_000;
    const body = relayInboundMessageRequestSchema.parse(input.body);
    if (this.opts.devLogEnabled) {
      logger.debug(
        { url, relayMessageId: body.relayMessageId, outcome: body.outcome },
        "Backend submitInboundMessage request"
      );
    }
    const res = await retry(
      () => postJson(url, this.opts.relayToken, body, timeoutMs),
      { attempts: 5, minDelayMs: 500, maxDelayMs: 10_000, label: "submitInboundMessage" }
    );
    const parsed = acceptedResponseSchema.parse(res);
    if (!parsed.accepted) {
      throw new Error("Backend rejected relay inbound message");
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
    const json = safeParseJson(text);
    if (json.ok === false) {
      const err = new Error(
        `Backend returned non-JSON response (status ${resp.status}, content-type ${resp.headers.get("content-type") ?? "unknown"}): ${previewText(text)}`
      ) as Error & NonJsonResponseError;
      err.status = resp.status;
      err.nonJsonResponse = true;
      err.contentType = resp.headers.get("content-type") ?? "unknown";
      err.bodyPreview = previewText(text);
      throw err;
    }

    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, "Backend returned non-2xx for relay request");
      const err = new Error(`Backend HTTP ${resp.status}`) as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }
    return json.value;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Backend request timed out");
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

type NonJsonResponseError = {
  status?: number;
  nonJsonResponse?: boolean;
  contentType?: string;
  bodyPreview?: string;
};

function asNonJsonError(err: unknown): (Error & NonJsonResponseError) | null {
  if (!(err instanceof Error)) return null;
  const typed = err as Error & NonJsonResponseError;
  return typed.nonJsonResponse ? typed : null;
}

function safeParseJson(
  text: string
): { ok: true; value: unknown } | { ok: false } {
  if (!text.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function previewText(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return "<empty>";
  const maxLen = 200;
  return normalized.length <= maxLen ? normalized : `${normalized.slice(0, maxLen)}...`;
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

