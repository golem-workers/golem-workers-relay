import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { logger } from "../logger.js";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export function startOpenRouterProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  const pathPrefix = normalizePrefix(input.pathPrefix);
  const backendPathPrefix = normalizePrefix(input.backendPathPrefix);
  const server = http.createServer((req, res) => {
    void handleProxyRequest(
      {
        req,
        res,
        backendBaseUrl: input.backendBaseUrl,
        relayToken: input.relayToken,
        pathPrefix,
        backendPathPrefix,
      },
      new AbortController()
    );
  });
  server.listen(input.port, "0.0.0.0", () => {
    logger.info(
      {
        port: input.port,
        pathPrefix,
        backendPathPrefix,
      },
      "Relay OpenRouter proxy server started"
    );
  });
  return server;
}

async function handleProxyRequest(
  input: {
    req: IncomingMessage;
    res: ServerResponse;
    backendBaseUrl: string;
    relayToken: string;
    pathPrefix: string;
    backendPathPrefix: string;
  },
  controller: AbortController
): Promise<void> {
  const { req, res } = input;
  const url = new URL(req.url ?? "/", "http://relay.local");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, status: "ok", service: "relay-openrouter-proxy" });
    return;
  }
  if (!url.pathname.startsWith(input.pathPrefix)) {
    sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
    return;
  }
  const method = req.method?.toUpperCase() ?? "GET";
  const upstreamPath = `${input.backendPathPrefix}${url.pathname}${url.search}`;
  const upstreamUrl = `${input.backendBaseUrl}${upstreamPath}`;
  const requestHeaders = buildUpstreamHeaders(req, input.relayToken);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  req.on("aborted", () => controller.abort());
  try {
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: requestHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : (req as unknown as never),
      duplex: method === "GET" || method === "HEAD" ? undefined : "half",
      signal: controller.signal,
    });
    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    if (controller.signal.aborted) {
      sendJson(res, 504, { code: "UPSTREAM_TIMEOUT", message: "Upstream timed out" });
      return;
    }
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        upstreamUrl,
      },
      "Relay OpenRouter proxy request failed"
    );
    sendJson(res, 502, { code: "UPSTREAM_ERROR", message: "Failed to proxy OpenRouter request" });
  } finally {
    clearTimeout(timeout);
  }
}

function buildUpstreamHeaders(
  req: IncomingMessage,
  relayToken: string
): Record<string, string> {
  const attemptHeader = readAttemptHeader(req);
  const out: Record<string, string> = {
    authorization: `Bearer ${relayToken}`,
    "x-gw-attempt": String(attemptHeader),
    // Keep upstream payload uncompressed to avoid decoding/header drift between hops.
    "accept-encoding": "identity",
  };
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (hopByHopHeaders.has(key)) continue;
    if (key === "authorization") continue;
    if (key.startsWith("x-forwarded-")) continue;
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      out[key] = rawValue.join(", ");
      continue;
    }
    out[key] = String(rawValue);
  }
  return out;
}

function readAttemptHeader(req: IncomingMessage): number {
  const raw =
    readHeader(req, "x-gw-attempt") ??
    readHeader(req, "x-openrouter-attempt") ??
    readHeader(req, "x-retry-attempt");
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(100, parsed));
}

function readHeader(req: IncomingMessage, key: string): string | null {
  const raw = req.headers[key];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) return raw[0].trim();
  return null;
}

function copyResponseHeaders(resp: Response, res: ServerResponse): void {
  for (const [key, value] of resp.headers.entries()) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    res.setHeader(key, value);
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function normalizePrefix(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  if (trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}
