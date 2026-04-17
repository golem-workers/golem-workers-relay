import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../logger.js";

export const LOCAL_PROXY_LISTEN_HOST = "127.0.0.1";

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

type RequestBodyMode = "passthrough" | "openrouter-model-rewrite";

type RelayProxyServerInput = {
  serviceName: string;
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefixes: string[];
  backendPathPrefix: string;
  requestBodyMode: RequestBodyMode;
  enableWebSocketProxy?: boolean;
};

function startRelayProxyServer(input: RelayProxyServerInput): http.Server {
  const pathPrefixes = dedupePrefixes(input.pathPrefixes.map((prefix) => normalizePrefix(prefix)));
  const backendPathPrefix = normalizePrefix(input.backendPathPrefix);
  const wss = input.enableWebSocketProxy ? new WebSocketServer({ noServer: true }) : null;
  const server = http.createServer((req, res) => {
    void handleProxyRequest(
      {
        req,
        res,
        serviceName: input.serviceName,
        backendBaseUrl: input.backendBaseUrl,
        relayToken: input.relayToken,
        pathPrefixes,
        backendPathPrefix,
        requestBodyMode: input.requestBodyMode,
      },
      new AbortController()
    ).catch((error) => {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          method: req.method ?? "GET",
          url: req.url ?? "/",
        },
        `${input.serviceName} request crashed`
      );
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 500, {
          code: "INTERNAL_ERROR",
          message: `${input.serviceName} crashed`,
        });
      }
    });
  });
  if (wss) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://relay.local");
      const matchedPathPrefix = matchPathPrefix(url.pathname, pathPrefixes);
      if (!matchedPathPrefix) {
        return;
      }
      void handleProxyWebSocketUpgrade({
        req,
        socket,
        head,
        wss,
        serviceName: input.serviceName,
        backendBaseUrl: input.backendBaseUrl,
        relayToken: input.relayToken,
        backendPathPrefix,
        matchedPathPrefix,
      }).catch((error) => {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            url: req.url ?? "/",
          },
          `${input.serviceName} websocket crashed`
        );
        rejectUpgrade(socket, 502, `${input.serviceName} websocket failed`);
      });
    });
  }
  server.listen(input.port, LOCAL_PROXY_LISTEN_HOST, () => {
    logger.info(
      {
        host: LOCAL_PROXY_LISTEN_HOST,
        port: input.port,
        pathPrefixes,
        backendPathPrefix,
      },
      `${input.serviceName} server started`
    );
  });
  return server;
}

export function startOpenRouterProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-openrouter-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/api/v1"],
    requestBodyMode: "openrouter-model-rewrite",
  });
}

export function startOpenAiProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-openai-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/v1"],
    requestBodyMode: "passthrough",
    enableWebSocketProxy: true,
  });
}

export function startGoogleAiProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-google-ai-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/"],
    requestBodyMode: "passthrough",
  });
}

export function startElevenlabsProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-elevenlabs-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/v1"],
    requestBodyMode: "passthrough",
  });
}

export function startFalProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-fal-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix],
    requestBodyMode: "passthrough",
  });
}

export function startRunwayProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-runway-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/v1"],
    requestBodyMode: "passthrough",
  });
}

export function startJinaProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-jina-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix, "/v1"],
    requestBodyMode: "passthrough",
  });
}

export function startMoonshotProxyServer(input: {
  port: number;
  backendBaseUrl: string;
  relayToken: string;
  pathPrefix: string;
  backendPathPrefix: string;
}): http.Server {
  return startRelayProxyServer({
    serviceName: "relay-moonshot-proxy",
    ...input,
    pathPrefixes: [input.pathPrefix],
    requestBodyMode: "passthrough",
  });
}

async function handleProxyRequest(
  input: {
    req: IncomingMessage;
    res: ServerResponse;
    serviceName: string;
    backendBaseUrl: string;
    relayToken: string;
    pathPrefixes: string[];
    backendPathPrefix: string;
    requestBodyMode: RequestBodyMode;
  },
  controller: AbortController
): Promise<void> {
  const { req, res } = input;
  const url = new URL(req.url ?? "/", "http://relay.local");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, status: "ok", service: input.serviceName });
    return;
  }
  const matchedPathPrefix = matchPathPrefix(url.pathname, input.pathPrefixes);
  if (!matchedPathPrefix) {
    sendJson(res, 404, { code: "NOT_FOUND", message: "Not found" });
    return;
  }
  const method = req.method?.toUpperCase() ?? "GET";
  const upstreamPath = `${input.backendPathPrefix}${stripPathPrefix(url.pathname, matchedPathPrefix)}${url.search}`;
  const upstreamUrl = `${input.backendBaseUrl}${upstreamPath}`;
  const requestHeaders = buildUpstreamHeaders(req, input.relayToken);
  const timeout = setTimeout(() => abortRequest(controller, "timeout"), 120_000);
  req.on("aborted", () => abortRequest(controller, "client_closed"));
  res.on("close", () => {
    if (!res.writableEnded) {
      abortRequest(controller, "client_closed");
    }
  });
  try {
    const preparedBody = await prepareUpstreamBody(
      req,
      method,
      url.pathname,
      input.requestBodyMode
    );
    const upstream = await fetch(upstreamUrl, {
      method,
      headers: requestHeaders,
      body: preparedBody.body as never,
      duplex: preparedBody.requiresDuplex ? "half" : undefined,
      signal: controller.signal,
    });
    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);
    if (!upstream.body) {
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body as unknown as ReadableStream<Uint8Array>), res);
    } catch (error) {
      if (shouldIgnoreProxyStreamError(error, controller, res)) {
        return;
      }
      throw error;
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "client_closed") {
      return;
    }
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 504, { code: "UPSTREAM_TIMEOUT", message: "Upstream timed out" });
      }
      return;
    }
    if (shouldIgnoreProxyStreamError(error, controller, res)) {
      return;
    }
    if (controller.signal.aborted) {
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, 504, { code: "UPSTREAM_TIMEOUT", message: "Upstream timed out" });
      }
      return;
    }
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        upstreamUrl,
      },
      `${input.serviceName} request failed`
    );
    if (!res.headersSent && !res.destroyed) {
      sendJson(res, 502, {
        code: "UPSTREAM_ERROR",
        message: `Failed to proxy request via ${input.serviceName}`,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleProxyWebSocketUpgrade(input: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  wss: WebSocketServer;
  serviceName: string;
  backendBaseUrl: string;
  relayToken: string;
  backendPathPrefix: string;
  matchedPathPrefix: string;
}): Promise<void> {
  const url = new URL(input.req.url ?? "/", "http://relay.local");
  const upstreamPath = `${input.backendPathPrefix}${stripPathPrefix(url.pathname, input.matchedPathPrefix)}${url.search}`;
  const upstreamUrl = toWebSocketUrl(input.backendBaseUrl, upstreamPath);
  const upstreamHeaders = buildWebSocketUpstreamHeaders(input.req, input.relayToken);
  const upstream = await openWebSocket(upstreamUrl, upstreamHeaders);
  input.wss.handleUpgrade(input.req, input.socket, input.head, (downstream) => {
    bridgeWebSockets(downstream, upstream);
  });
}

function abortRequest(controller: AbortController, reason: "timeout" | "client_closed"): void {
  if (!controller.signal.aborted) {
    controller.abort(reason);
  }
}

function shouldIgnoreProxyStreamError(
  error: unknown,
  controller: AbortController,
  res: ServerResponse
): boolean {
  if (res.destroyed || controller.signal.reason === "client_closed") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("aborted") ||
    message.includes("premature close") ||
    message.includes("socket hang up") ||
    message.includes("connection reset")
  );
}

async function prepareUpstreamBody(
  req: IncomingMessage,
  method: string,
  pathname: string,
  requestBodyMode: RequestBodyMode
): Promise<{ body: unknown; requiresDuplex: boolean }> {
  if (method === "GET" || method === "HEAD") {
    return { body: undefined, requiresDuplex: false };
  }
  if (
    requestBodyMode !== "openrouter-model-rewrite" ||
    !shouldRewriteModel(pathname, req.headers["content-type"])
  ) {
    return { body: req as unknown as never, requiresDuplex: true };
  }
  const rawBody = await readRequestBody(req);
  const rewritten = rewriteOpenrouterModelField(rawBody);
  return { body: rewritten, requiresDuplex: false };
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

function buildWebSocketUpstreamHeaders(
  req: IncomingMessage,
  relayToken: string
): Record<string, string> {
  const out = buildUpstreamHeaders(req, relayToken);
  for (const key of Object.keys(out)) {
    if (key.startsWith("sec-websocket-")) {
      delete out[key];
    }
  }
  delete out.connection;
  delete out.upgrade;
  delete out.host;
  delete out["content-length"];
  delete out["content-type"];
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

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) {
    return;
  }
  socket.write(
    `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n` +
      "\r\n" +
      message
  );
  socket.destroy();
}

function toWebSocketUrl(baseUrl: string, pathWithQuery: string): string {
  const base = new URL(baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return new URL(pathWithQuery, base).toString();
}

async function openWebSocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      cleanup();
      reject(
        new Error(
          `Upstream websocket rejected with ${response.statusCode ?? 502} ${response.statusMessage ?? "Error"}`
        )
      );
      response.resume();
      ws.close();
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("unexpected-response", onUnexpectedResponse);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("unexpected-response", onUnexpectedResponse);
  });
}

function bridgeWebSockets(left: WebSocket, right: WebSocket): void {
  let closed = false;
  const closeBoth = (code?: number, reason?: Buffer) => {
    if (closed) return;
    closed = true;
    if (left.readyState === WebSocket.OPEN || left.readyState === WebSocket.CONNECTING) {
      left.close(code, reason);
    }
    if (right.readyState === WebSocket.OPEN || right.readyState === WebSocket.CONNECTING) {
      right.close(code, reason);
    }
  };
  left.on("message", (data, isBinary) => {
    if (right.readyState === WebSocket.OPEN) {
      right.send(data, { binary: isBinary });
    }
  });
  right.on("message", (data, isBinary) => {
    if (left.readyState === WebSocket.OPEN) {
      left.send(data, { binary: isBinary });
    }
  });
  left.on("close", (code, reason) => closeBoth(code, reason));
  right.on("close", (code, reason) => closeBoth(code, reason));
  left.on("error", () => closeBoth(1011));
  right.on("error", () => closeBoth(1011));
}

function httpStatusText(statusCode: number): string {
  if (statusCode === 401) return "Unauthorized";
  if (statusCode === 403) return "Forbidden";
  if (statusCode === 404) return "Not Found";
  if (statusCode === 502) return "Bad Gateway";
  return "Error";
}

function normalizePrefix(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  if (trimmed === "/") return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}

function dedupePrefixes(prefixes: string[]): string[] {
  return [...new Set(prefixes)].sort((left, right) => right.length - left.length);
}

function matchPathPrefix(pathname: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (prefix === "/") {
      return prefix;
    }
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return prefix;
    }
  }
  return null;
}

function stripPathPrefix(pathname: string, prefix: string): string {
  if (prefix === "/") {
    return pathname || "/";
  }
  const stripped = pathname.slice(prefix.length);
  return stripped.length > 0 ? stripped : "/";
}

function shouldRewriteModel(pathname: string, contentType: string | string[] | undefined): boolean {
  const ct = Array.isArray(contentType) ? contentType.join(",").toLowerCase() : String(contentType ?? "").toLowerCase();
  if (!ct.includes("application/json")) return false;
  return (
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/responses") ||
    pathname.endsWith("/completions")
  );
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

function rewriteOpenrouterModelField(rawBody: Buffer): Uint8Array {
  const rawText = rawBody.toString("utf8");
  try {
    const payload = JSON.parse(rawText) as { model?: unknown };
    if (typeof payload.model === "string" && payload.model.startsWith("openrouter/")) {
      payload.model = payload.model.slice("openrouter/".length);
      return new TextEncoder().encode(JSON.stringify(payload));
    }
  } catch {
    // Pass-through raw bytes if payload is not valid JSON.
  }
  return rawBody;
}
