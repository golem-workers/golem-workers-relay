import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { logger } from "../logger.js";
import { inboundPushMessageSchema, type InboundPushMessage } from "../backend/types.js";

const MAX_BODY_BYTES = 15 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
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
  onMessage: (message: InboundPushMessage) => Promise<void>;
}): http.Server {
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== path) {
      sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
      return;
    }

    const token = parseBearer(req);
    if (!token || token !== input.relayToken) {
      sendJson(res, 401, { code: "UNAUTHORIZED", message: "Invalid relay token" });
      return;
    }

    try {
      const raw = await readBody(req);
      const parsedJson = raw.trim() ? (JSON.parse(raw) as unknown) : null;
      const parsed = inboundPushMessageSchema.safeParse(parsedJson);
      if (!parsed.success) {
        sendJson(res, 400, {
          code: "VALIDATION_ERROR",
          message: "Invalid push payload",
          details: parsed.error.flatten(),
        });
        return;
      }
      await input.onMessage(parsed.data);
      sendJson(res, 200, { accepted: true });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Push server request failed");
      sendJson(res, 500, { code: "PUSH_SERVER_ERROR", message: "Failed to process push message" });
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  server.listen(input.port, "0.0.0.0", () => {
    logger.info({ port: input.port, path }, "Relay push server started");
  });
  return server;
}
