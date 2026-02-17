import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { logger } from "../logger.js";
import { buildDeviceAuthPayload } from "./deviceAuthPayload.js";
import {
  type EventFrame,
  type HelloOk,
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
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: HelloOk) => void;
};

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

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureReady();
    const id = randomUUID();
    const frame = { type: "req" as const, id, method, params };

    const text = JSON.stringify(frame);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws?.send(text);
      } catch (err) {
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
      // Wait briefly for connect.challenge; local gateways may still emit it.
      setTimeout(() => this.sendConnectIfNeeded(), 50);
    });
    this.ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    this.ws.on("close", (code, reason) => {
      const reasonText = typeof reason === "string" ? reason : reason.toString("utf8");
      logger.warn({ code, reason: reasonText }, "Gateway websocket closed");
      this.ws = null;
      this.hello = null;
      this.readyPromise = null;
      this.readyResolve = null;
      this.readyReject = null;
      this.flushPending(new Error(`gateway closed (${code}): ${reasonText}`));
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private flushPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }

    const frameResult = frameSchema.safeParse(parsed);
    if (!frameResult.success) {
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
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        const code = frame.error?.code ?? "GATEWAY_ERROR";
        const msg = frame.error?.message ?? "Gateway request failed";
        pending.reject(new Error(`${code}: ${msg}`));
      }
    }
  }

  private handleEvent(evt: EventFrame): void {
    if (evt.event === "tick") {
      this.lastTickMs = Date.now();
      return;
    }
    if (evt.event === "connect.challenge") {
      const challenge = connectChallengeEventSchema.safeParse(evt.payload);
      if (challenge.success) {
        this.connectNonce = challenge.data.nonce;
        this.sendConnectIfNeeded();
      }
      return;
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
    this.pending.set(id, {
      resolve: (value) => this.onConnectResponse(value),
      reject: (err) => this.onConnectError(err),
    });
    try {
      this.ws.send(JSON.stringify(frame));
    } catch (err) {
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

