import { z } from "zod";

import { retryWithBackoff } from "../common/resilience/retry.js";
import {
  agentLifecycleEventSchema,
  type AgentLifecycleEvent,
} from "./contract.js";

const generationResponseSchema = z
  .object({
    accepted: z.literal(true),
    disposition: z.enum(["CURRENT", "ACTIVATED"]),
    serverId: z.string().min(1),
    sourceGeneration: z.string().min(1),
    generationOrdinal: z.number().int().positive(),
    activeRuns: z.array(
      z
        .object({
          provider: z.string().min(1),
          agentId: z.string().min(1).nullable(),
          sessionId: z.string().min(1),
          runId: z.string().min(1),
          status: z.enum(["RUNNING", "WAITING"]),
        })
        .strict(),
    ),
  })
  .strict();

const ingestionResponseSchema = z
  .object({
    accepted: z.literal(true),
    disposition: z.enum([
      "APPLIED",
      "DUPLICATE",
      "UNCHANGED",
      "STALE_GENERATION",
    ]),
    eventId: z.string().min(1),
    expectedSequence: z.number().int().positive().optional(),
  })
  .strict();

export type AgentLifecycleGenerationResponse = z.infer<
  typeof generationResponseSchema
>;
export type AgentLifecycleIngestionResponse = z.infer<
  typeof ingestionResponseSchema
>;

export type AgentLifecycleBackend = {
  registerGeneration(input: {
    sourceGeneration: string;
    registeredAt?: string;
  }): Promise<AgentLifecycleGenerationResponse>;
  submitEvent(
    event: AgentLifecycleEvent,
  ): Promise<AgentLifecycleIngestionResponse>;
};

export class AgentLifecycleBackendHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentLifecycleBackendHttpError";
  }
}

export function createAgentLifecycleBackend(input: {
  baseUrl: string;
  relayToken: string;
}): AgentLifecycleBackend {
  const post = async (path: string, body: unknown): Promise<unknown> =>
    retryWithBackoff(
      () => postJson(`${input.baseUrl}${path}`, input.relayToken, body),
      {
        attempts: 3,
        baseDelayMs: [400, 1_200, 3_000],
        jitterMs: 200,
        shouldRetry: isRetryable,
      },
    );

  return {
    async registerGeneration(request) {
      return generationResponseSchema.parse(
        await post("/api/v1/relays/agent-lifecycle/generations", request),
      );
    },

    async submitEvent(event) {
      const body = agentLifecycleEventSchema.parse(event);
      return ingestionResponseSchema.parse(
        await post("/api/v1/relays/agent-lifecycle/events", body),
      );
    },
  };
}

async function postJson(
  url: string,
  relayToken: string,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relayToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = safeJson(text);
    if (!response.ok) {
      throw new AgentLifecycleBackendHttpError(
        response.status,
        `Agent lifecycle backend HTTP ${response.status}`,
        readErrorCode(parsed),
        readErrorDetails(parsed),
      );
    }
    return text.trim() ? parsed : null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Agent lifecycle backend request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function readErrorDetails(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as { details?: unknown }).details;
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof AgentLifecycleBackendHttpError)) {
    return true;
  }
  return error.status === 429 || error.status >= 500;
}
