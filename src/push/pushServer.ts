import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { logger } from "../logger.js";
import { inboundPushMessageSchema, type InboundPushMessage } from "../backend/types.js";
import { resolveOpenclawStateDir } from "../common/utils/paths.js";
import { resolveRelayMediaFile } from "../openclaw/mediaDirectives.js";

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
  onTransportEvent?: (message: InboundPushMessage) => Promise<void>;
}): http.Server {
  const pushPath = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const mediaPath = replaceLastPathSegment(pushPath, "media");
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

    if (pathname === mediaPath && req.method === "GET") {
      const token = parseBearer(req);
      if (!token || token !== input.relayToken) {
        sendJson(res, 401, { code: "UNAUTHORIZED", message: "Invalid relay token" });
        return;
      }
      try {
        const mediaReference = (url.searchParams.get("path") ?? "").trim();
        if (!mediaReference) {
          sendJson(res, 400, { code: "VALIDATION_ERROR", message: "path query parameter is required" });
          return;
        }
        const stateDir = resolveOpenclawStateDir(process.env);
        const resolved = await resolveRelayMediaFile({
          stateDir,
          workspaceRoot: nodePath.join(stateDir, "workspace"),
          mediaPath: mediaReference,
        });
        const payload = await fs.readFile(resolved.absPath);
        if (payload.byteLength <= 0) {
          sendJson(res, 404, { code: "MEDIA_NOT_FOUND", message: "Media file is empty or unavailable" });
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", sniffContentType(resolved.relPath));
        res.setHeader("content-length", String(payload.byteLength));
        res.end(payload);
      } catch (error) {
        sendJson(res, 404, {
          code: "MEDIA_NOT_FOUND",
          message: error instanceof Error ? error.message : "Media file was not found",
        });
      }
      return;
    }

    if (req.method !== "POST" || pathname !== pushPath) {
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
      if (parsed.data.input.kind === "transport_event") {
        if (!input.onTransportEvent) {
          throw new PushServerHttpError({
            statusCode: 503,
            code: "TRANSPORT_EVENT_UNSUPPORTED",
            message: "Relay transport event ingress is not enabled",
          });
        }
        await input.onTransportEvent(parsed.data);
      } else {
        await input.onMessage(parsed.data);
      }
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
    logger.info({ port: input.port, path: pushPath }, "Relay push server started");
  });
  return server;
}

function replaceLastPathSegment(input: string, nextSegment: string): string {
  const parts = input.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return `/${nextSegment}`;
  }
  parts[parts.length - 1] = nextSegment;
  return `/${parts.join("/")}`;
}

function sniffContentType(filePath: string): string {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (normalized.endsWith(".json")) return "application/json; charset=utf-8";
  if (normalized.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (normalized.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
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
