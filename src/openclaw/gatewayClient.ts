import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { logger } from "../logger.js";
import { buildDeviceAuthPayload } from "./deviceAuthPayload.js";
import {
  type EventFrame,
  type HelloOk,
  chatEventSchema,
  connectChallengeEventSchema,
  frameSchema,
  helloOkSchema,
} from "./protocol.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "./deviceIdentity.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  instanceId?: string;
  role?: string;
  scopes?: string[];
  minProtocol?: number;
  maxProtocol?: number;
  requestTimeoutMs?: number;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: HelloOk) => void;
  devLogEnabled?: boolean;
  devLogTextMaxLen?: number;
  devLogGatewayFrames?: boolean;
};

function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

function summarizeRequestParams(method: string, params: unknown, textMaxLen: number): unknown {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  if (method === "chat.send") {
    const message = typeof p.message === "string" ? p.message : "";
    return {
      sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : null,
      messageLen: message.length,
      messagePreview: makeTextPreview(message, textMaxLen),
      idempotencyKey: typeof p.idempotencyKey === "string" ? p.idempotencyKey : null,
      timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : null,
    };
  }
  if (method === "chat.abort") {
    return {
      sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : null,
      runId: typeof p.runId === "string" ? p.runId : null,
    };
  }
  if (method === "connect") {
    // Avoid logging full connect params; they contain signature/auth details.
    return { keys: Object.keys(p).slice(0, 20) };
  }
  return { keys: Object.keys(p).slice(0, 20) };
}

function summarizeChatMessage(message: unknown, textMaxLen: number): unknown {
  if (typeof message === "string") {
    return {
      type: "string",
      messageLen: message.length,
      messagePreview: makeTextPreview(message, textMaxLen),
    };
  }
  if (message && typeof message === "object") {
    const text = (message as { text?: unknown }).text;
    return {
      type: "object",
      keys: Object.keys(message as Record<string, unknown>).slice(0, 20),
      textLen: typeof text === "string" ? text.length : null,
      textPreview: typeof text === "string" ? makeTextPreview(text, textMaxLen) : null,
    };
  }
  return {
    type: typeof message,
    value: message ?? null,
  };
}

function summarizeResponsePayload(method: string, payload: unknown, textMaxLen: number): unknown {
  if (method === "chat.send" && payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    return {
      runId: typeof p.runId === "string" ? p.runId : null,
      accepted: p.accepted === true,
      keys: Object.keys(p).slice(0, 20),
    };
  }
  if (method === "connect" && payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const policy = p.policy && typeof p.policy === "object" ? (p.policy as Record<string, unknown>) : null;
    return {
      protocol: typeof p.protocol === "number" ? p.protocol : null,
      tickIntervalMs: typeof policy?.tickIntervalMs === "number" ? policy.tickIntervalMs : null,
      keys: Object.keys(p).slice(0, 20),
    };
  }
  if (payload && typeof payload === "object") {
    return { keys: Object.keys(payload as Record<string, unknown>).slice(0, 20) };
  }
  if (typeof payload === "string") {
    return { textLen: payload.length, textPreview: makeTextPreview(payload, textMaxLen) };
  }
  return payload ?? null;
}

function summarizeEventPayload(evt: EventFrame, textMaxLen: number): unknown {
  if (evt.event === "chat") {
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) {
      return { parsed: false };
    }
    const chat = parsed.data;
    return {
      parsed: true,
      runId: chat.runId,
      state: chat.state,
      message: chat.message !== undefined ? summarizeChatMessage(chat.message, textMaxLen) : null,
      errorMessage:
        typeof chat.errorMessage === "string"
          ? {
              len: chat.errorMessage.length,
              preview: makeTextPreview(chat.errorMessage, textMaxLen),
            }
          : null,
    };
  }
  if (evt.payload && typeof evt.payload === "object") {
    return { keys: Object.keys(evt.payload as Record<string, unknown>).slice(0, 20) };
  }
  if (typeof evt.payload === "string") {
    return { textLen: evt.payload.length, textPreview: makeTextPreview(evt.payload, textMaxLen) };
  }
  return evt.payload ?? null;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private pending = new Map<string, Pending>();
  private connectNonce: string | null = null;
  private connectSent = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private hello: HelloOk | null = null;

  private lastTickMs: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;

  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private stopped = false;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    this.open();
    return this.readyPromise;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  isReady(): boolean {
    return !!this.hello;
  }

  getHello(): HelloOk | null {
    return this.hello;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureReady();
    const id = randomUUID();
    const frame = { type: "req" as const, id, method, params };

    const text = JSON.stringify(frame);
    if (this.opts.devLogEnabled) {
      const textMaxLen = this.opts.devLogTextMaxLen ?? 200;
      logger.debug({ id, method, params: summarizeRequestParams(method, params, textMaxLen) }, "Gateway request send");
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.ws?.send(text);
      } catch (err) {
        const p = this.pending.get(id);
        if (p) clearTimeout(p.timeout);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.hello) return;
    // Reconnect-safe: if the socket dropped after a prior successful connect,
    // the `readyPromise` might already be resolved but `hello` is null.
    for (;;) {
      if (this.hello) return;
      if (!this.readyPromise) {
        await this.start();
      }
      await this.readyPromise;
      if (this.hello) return;
      // If hello is still missing, reset and retry.
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private open(): void {
    if (this.stopped) return;
    if (this.ws) return;

    this.connectNonce = null;
    this.connectSent = false;
    this.hello = null;

    const url = this.opts.url;
    logger.info({ url }, "Connecting to OpenClaw gateway");
    this.ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

    this.ws.on("open", () => {
      // Some gateways emit `connect.challenge` asynchronously; sending `connect`
      // too early (without a nonce) can be rejected for non-local connects.
      // Fallback: if no challenge arrives, send a nonce-less connect after a delay.
      // Ensure we send `connect` promptly; gateways may close sockets that don't
      // send a first frame quickly. If `connect.challenge` arrives first, it
      // will trigger `sendConnectIfNeeded()` with a nonce.
      setTimeout(() => this.sendConnectIfNeeded(), 50);
    });
    this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    this.ws.on("close", (code, reason) => {
      const reasonText = typeof reason === "string" ? reason : reason.toString("utf8");
      logger.warn({ code, reason: reasonText }, "Gateway websocket closed");
      this.ws = null;
      this.hello = null;
      const closedErr = new Error(`gateway closed (${code}): ${reasonText}`);
      // If we weren't ready yet, reject the pending `start()` promise so callers
      // can retry instead of hanging forever.
      if (this.readyReject) {
        try {
          this.readyReject(closedErr);
        } catch {
          // ignore
        }
      }
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.flushPending(closedErr);
      this.scheduleReconnect();
    });
    this.ws.on("error", (err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Gateway websocket error");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(30_000, Math.floor(this.backoffMs * 1.5));
    if (this.opts.devLogEnabled) {
      logger.debug({ delayMs: delay, nextBackoffMs: this.backoffMs }, "Gateway reconnect scheduled");
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private flushPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(text: string): void {
    const textMaxLen = this.opts.devLogTextMaxLen ?? 200;
    if (this.opts.devLogGatewayFrames) {
      logger.debug(
        { size: text.length, preview: makeTextPreview(text, textMaxLen) },
        "Gateway frame received"
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      if (this.opts.devLogGatewayFrames) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            size: text.length,
            preview: makeTextPreview(text, textMaxLen),
          },
          "Gateway frame parse failed"
        );
      }
      return;
    }

    const frameResult = frameSchema.safeParse(parsed);
    if (!frameResult.success) {
      if (this.opts.devLogGatewayFrames) {
        logger.warn(
          {
            size: text.length,
            preview: makeTextPreview(text, textMaxLen),
          },
          "Gateway frame schema mismatch"
        );
      }
      return;
    }
    const frame = frameResult.data;

    if (frame.type === "event") {
      this.handleEvent(frame);
      return;
    }

    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(frame.id);
      if (frame.ok) {
        if (this.opts.devLogEnabled) {
          logger.debug(
            {
              id: frame.id,
              method: pending.method,
              ok: true,
              payload: summarizeResponsePayload(pending.method, frame.payload, textMaxLen),
            },
            "Gateway response ok"
          );
        }
        pending.resolve(frame.payload);
      } else {
        const code = frame.error?.code ?? "GATEWAY_ERROR";
        const msg = frame.error?.message ?? "Gateway request failed";
        if (this.opts.devLogEnabled) {
          logger.warn({ id: frame.id, method: pending.method, ok: false, code, message: msg }, "Gateway response error");
        }
        pending.reject(new Error(`${code}: ${msg}`));
      }
    }
  }

  private handleEvent(evt: EventFrame): void {
    if (evt.event === "tick") {
      this.lastTickMs = Date.now();
      if (this.opts.devLogGatewayFrames) {
        logger.debug({ event: "tick" }, "Gateway tick");
      }
      return;
    }
    if (evt.event === "connect.challenge") {
      const challenge = connectChallengeEventSchema.safeParse(evt.payload);
      if (challenge.success) {
        this.connectNonce = challenge.data.nonce;
        if (this.opts.devLogEnabled) {
          logger.debug({ event: "connect.challenge", hasNonce: true }, "Gateway connect challenge received");
        }
        this.sendConnectIfNeeded();
      }
      return;
    }
    if (this.opts.devLogEnabled) {
      const textMaxLen = this.opts.devLogTextMaxLen ?? 200;
      logger.debug({ event: evt.event, payload: summarizeEventPayload(evt, textMaxLen) }, "Gateway event");
    }
    this.opts.onEvent?.(evt);
  }

  private startTickWatchdog(intervalMs: number): void {
    this.tickIntervalMs = intervalMs;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.ws) return;
      if (!this.lastTickMs) return;
      const elapsed = Date.now() - this.lastTickMs;
      if (elapsed > this.tickIntervalMs * 2) {
        logger.warn({ elapsed, tickIntervalMs: this.tickIntervalMs }, "Tick timeout, closing gateway socket");
        try {
          this.ws.close(4000, "tick timeout");
        } catch {
          // ignore
        }
      }
    }, Math.max(1000, Math.floor(intervalMs / 2)));
  }

  private sendConnectIfNeeded(): void {
    if (this.connectSent) return;
    if (!this.ws) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    this.connectSent = true;

    const identity = loadOrCreateDeviceIdentity(process.env);
    const role = this.opts.role ?? "operator";
    const scopes = this.opts.scopes ?? ["operator.admin"];
    const clientId = "gateway-client";
    const clientMode = "backend";
    const signedAtMs = Date.now();
    const authToken = this.opts.token ?? undefined;
    const auth =
      authToken || this.opts.password
        ? { token: authToken, password: this.opts.password }
        : undefined;

    const payload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: authToken ?? null,
      nonce: this.connectNonce ?? undefined,
    });
    const signature = signDevicePayload(identity.privateKeyPem, payload);

    const connectParams = {
      minProtocol: this.opts.minProtocol ?? 3,
      maxProtocol: this.opts.maxProtocol ?? 3,
      client: {
        id: clientId,
        version: process.env.npm_package_version
          ? `golem-workers-relay/${process.env.npm_package_version}`
          : "golem-workers-relay/0.1.0",
        platform: process.platform,
        mode: clientMode,
        instanceId: this.opts.instanceId,
      },
      role,
      scopes,
      caps: [],
      auth,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce: this.connectNonce ?? undefined,
      },
    };

    const id = randomUUID();
    const frame = { type: "req" as const, id, method: "connect", params: connectParams };
    const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
    const timeout = setTimeout(() => {
      this.pending.delete(id);
      this.onConnectError(new Error("Gateway connect timed out"));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        this.onConnectResponse(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        this.onConnectError(err);
      },
      timeout,
      method: "connect",
    });
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(id);
      this.onConnectError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onConnectResponse(payload: unknown): void {
    const parsed = helloOkSchema.safeParse(payload);
    if (!parsed.success) {
      this.onConnectError(new Error("Invalid hello-ok payload"));
      return;
    }

    this.hello = parsed.data;
    this.backoffMs = 1000;
    this.lastTickMs = Date.now();
    this.startTickWatchdog(this.hello.policy.tickIntervalMs);
    this.opts.onHelloOk?.(this.hello);

    logger.info(
      { protocol: this.hello.protocol, tickIntervalMs: this.hello.policy.tickIntervalMs },
      "Connected to OpenClaw gateway"
    );

    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private onConnectError(err: Error): void {
    logger.warn({ err: err.message }, "Gateway connect failed");
    this.hello = null;
    if (this.readyReject) {
      this.readyReject(err);
      this.readyResolve = null;
      this.readyReject = null;
      this.readyPromise = null;
    }
    try {
      this.ws?.close(1008, "connect failed");
    } catch {
      // ignore
    }
  }
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data) && data.every((x) => Buffer.isBuffer(x))) {
    return Buffer.concat(data).toString("utf8");
  }
  try {
    return String(data);
  } catch {
    return "";
  }
}

