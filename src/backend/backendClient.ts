import { logger } from "../logger.js";
import { retryWithBackoff } from "../common/resilience/retry.js";
import { CircuitBreaker } from "../common/resilience/circuitBreaker.js";
import {
  type RelayInboundMessageRequest,
  relayInboundMessageRequestSchema,
  acceptedResponseSchema,
} from "./types.js";

export type BackendClientOptions = {
  baseUrl: string;
  relayToken: string;
  devLogEnabled?: boolean;
  circuitBreaker?: {
    writeFailureThreshold?: number;
    writeOpenForMs?: number;
  };
};

export class BackendClient {
  private readonly writeBreaker: CircuitBreaker;

  constructor(private readonly opts: BackendClientOptions) {
    this.writeBreaker = new CircuitBreaker({
      failureThreshold: opts.circuitBreaker?.writeFailureThreshold ?? 8,
      openForMs: opts.circuitBreaker?.writeOpenForMs ?? 5_000,
    });
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
    await this.writeBreaker.execute(async () => {
      const res = await retryWithBackoff(
        () => postJson(url, this.opts.relayToken, body, timeoutMs),
        {
          attempts: 5,
          baseDelayMs: [500, 900, 1600, 3000, 6000, 10_000],
          jitterMs: 250,
          shouldRetry: (err) => isRetryableBackendError(err),
          onRetry: ({ error, attempt, sleepMs }) => {
            const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
            logger.warn({ attempt, sleepMs, label: "submitInboundMessage", status: status ?? null }, "Retrying backend request");
          },
        }
      );
      const parsed = acceptedResponseSchema.parse(res);
      if (!parsed.accepted) {
        throw new Error("Backend rejected relay inbound message");
      }
    });
    return { accepted: true };
  }

  getResilienceState(): {
    writeBreaker: { state: "closed" | "open" | "half_open"; consecutiveFailures: number; retryAfterMs: number };
  } {
    return {
      writeBreaker: this.writeBreaker.getState(),
    };
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

function isRetryableBackendError(err: unknown): boolean {
  const status = err instanceof Error ? (err as Error & { status?: number }).status : undefined;
  return status === undefined || (status >= 500 && status <= 599) || status === 429;
}

