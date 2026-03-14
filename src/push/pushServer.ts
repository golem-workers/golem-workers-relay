import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { logger } from "../logger.js";
import { inboundPushMessageSchema, type InboundPushMessage } from "../backend/types.js";

// Telegram voice/file limits are measured on binary payload size, but relay traffic
// carries the same media as base64 JSON, which expands by roughly 33%.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

export class PushServerHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(input: { statusCode: number; code: string; message: string; details?: unknown }) {
    super(input.message);
    this.statusCode = input.statusCode;
    this.code = input.code;
    this.details = input.details;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const resolveOnce = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectOnce(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("aborted", () => rejectOnce(new Error("Client closed request body stream")));
    req.on("end", () => resolveOnce(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => rejectOnce(error instanceof Error ? error : new Error(String(error))));
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseBearer(req: IncomingMessage): string | null {
  const rawHeader: unknown = req.headers["authorization"];
  let raw: string | null = null;
  if (typeof rawHeader === "string") {
    raw = rawHeader;
  } else if (Array.isArray(rawHeader)) {
    const first = (rawHeader as unknown[])[0];
    if (typeof first === "string") {
      raw = first;
    }
  }
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

export function startPushServer(input: {
  port: number;
  path: string;
  relayToken: string;
  rateLimitPerSecond?: number;
  maxConcurrentRequests?: number;
  healthPath?: string;
  readinessPath?: string;
  getHealth?: () => { ok: boolean; ready: boolean; details?: unknown };
  onMessage: (message: InboundPushMessage) => Promise<void>;
}): http.Server {
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const healthPath = input.healthPath?.trim() || "/health";
  const readinessPath = input.readinessPath?.trim() || "/ready";
  const rateLimitPerSecond = Math.max(1, Math.trunc(input.rateLimitPerSecond ?? 100));
  const maxConcurrentRequests = Math.max(1, Math.trunc(input.maxConcurrentRequests ?? 100));
  let rateWindowSec = Math.floor(Date.now() / 1000);
  let rateWindowCount = 0;
  let activeRequests = 0;

  const isRateLimited = (): boolean => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec !== rateWindowSec) {
      rateWindowSec = nowSec;
      rateWindowCount = 0;
    }
    rateWindowCount += 1;
    return rateWindowCount > rateLimitPerSecond;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === healthPath) {
      const state = input.getHealth?.() ?? { ok: true, ready: true };
      sendJson(res, state.ok ? 200 : 503, {
        status: state.ok ? "ok" : "degraded",
        ...state,
      });
      return;
    }
    if (req.method === "GET" && pathname === readinessPath) {
      const state = input.getHealth?.() ?? { ok: true, ready: true };
      sendJson(res, state.ready ? 200 : 503, {
        status: state.ready ? "ready" : "not_ready",
        ...state,
      });
      return;
    }

    if (req.method !== "POST" || pathname !== path) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
      return;
    }

    const token = parseBearer(req);
    if (!token || token !== input.relayToken) {
      logger.warn(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "rejected",
          status: 401,
          error: "Invalid relay token",
        },
        "Message flow transition"
      );
      sendJson(res, 401, { code: "UNAUTHORIZED", message: "Invalid relay token" });
      return;
    }

    if (isRateLimited()) {
      logger.warn(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "rejected",
          status: 429,
          error: "Push request rate limit exceeded",
        },
        "Message flow transition"
      );
      sendJson(res, 429, { code: "RATE_LIMITED", message: "Push request rate limit exceeded" });
      return;
    }
    if (activeRequests >= maxConcurrentRequests) {
      logger.warn(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "rejected",
          status: 503,
          error: "Relay push server is busy",
        },
        "Message flow transition"
      );
      sendJson(res, 503, { code: "BUSY", message: "Relay push server is busy" });
      return;
    }

    activeRequests += 1;
    try {
      const raw = await readBody(req);
      const parsedJson = raw.trim() ? (JSON.parse(raw) as unknown) : null;
      const parsed = inboundPushMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        logger.warn(
          {
            event: "message_flow",
            direction: "backend_to_relay",
            stage: "rejected",
            status: 400,
            error: "Invalid push payload",
          },
          "Message flow transition"
        );
        sendJson(res, 400, {
          code: "VALIDATION_ERROR",
          message: "Invalid push payload",
          details: parsed.error.flatten(),
        });
        return;
      }
      await input.onMessage(parsed.data);
      logger.info(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "accepted",
          backendMessageId: parsed.data.messageId,
          relayMessageId: null,
          kind: parsed.data.input.kind,
          status: 200,
        },
        "Message flow transition"
      );
      sendJson(res, 200, { accepted: true });
    } catch (error) {
      if (error instanceof PushServerHttpError) {
        logger.warn(
          {
            event: "message_flow",
            direction: "backend_to_relay",
            stage: "rejected",
            status: error.statusCode,
            error: error.message,
          },
          "Message flow transition"
        );
        sendJson(res, error.statusCode, {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
        return;
      }
      if (isClientDisconnectError(error) || res.destroyed) {
        return;
      }
      logger.warn(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "failed",
          status: 500,
          error: error instanceof Error ? error.message : String(error),
        },
        "Message flow transition"
      );
      sendJson(res, 500, { code: "PUSH_SERVER_ERROR", message: "Failed to process push message" });
    } finally {
      activeRequests = Math.max(0, activeRequests - 1);
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      logger.warn(
        {
          event: "message_flow",
          direction: "backend_to_relay",
          stage: "failed",
          status: 500,
          error: error instanceof Error ? error.message : String(error),
          method: req.method ?? "GET",
          path: req.url ?? "/",
        },
        "Push server request crashed"
      );
      sendJson(res, 500, { code: "PUSH_SERVER_ERROR", message: "Failed to process push message" });
    });
  });

  server.listen(input.port, "0.0.0.0", () => {
    logger.info({ port: input.port, path }, "Relay push server started");
  });
  return server;
}

function isClientDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    message.includes("client closed") ||
    message.includes("aborted") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}
