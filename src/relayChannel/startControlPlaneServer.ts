import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type BackendClient } from "../backend/backendClient.js";
import { logger } from "../logger.js";
import {
  buildActionCompleted,
  buildHelloResponse,
  buildProtocolError,
  helloRequestSchema,
  transportActionRequestSchema,
} from "./controlPlaneProtocol.js";
import { executeTelegramTransportActionViaBackend } from "./telegramBackendTransport.js";
import { executeWhatsAppPersonalMessageSend } from "./whatsappPersonalTransport.js";

const EVENT_DELIVERY_RETRY_MS = 10_000;
const MAX_EVENT_DELIVERY_ATTEMPTS = 10;
const PLUGIN_EVENT_PORT_OFFSET = 2;

type PendingRelayEvent = {
  event: Record<string, unknown>;
  attempt: number;
  coalescingKey: string | null;
  textMergeKey: string | null;
  lastError: string | null;
};

export type ControlPlaneRuntimeState = {
  enabled: boolean;
  listening: boolean;
  host: string;
  port: number;
  clientConnected: boolean;
  lastAccountId: string | null;
};

export function startRelayChannelControlPlane(input: {
  host: string;
  port: number;
  relayInstanceId: string;
  getDataPlane: () => {
    uploadBaseUrl: string;
    downloadBaseUrl: string;
    registerDownload: (input: {
      body: Buffer;
      contentType: string;
      fileName: string;
      expiresAtMs?: number;
      token?: string;
    }) => { token: string; downloadUrl: string };
  };
  backend: BackendClient;
  onStateChange?: (state: ControlPlaneRuntimeState) => void;
}): {
  server: ReturnType<typeof createServer>;
  getState: () => ControlPlaneRuntimeState;
  publishEvent: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
} {
  let lastAccountId: string | null = null;
  let closed = false;
  let listening = false;
  let clientConnected = false;
  let processingEvents = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingEvents: PendingRelayEvent[] = [];

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const getState = (): ControlPlaneRuntimeState => ({
    enabled: true,
    listening,
    host: input.host,
    port: resolveListeningPort(server, input.port),
    clientConnected,
    lastAccountId,
  });

  server.on("listening", () => {
    listening = true;
    logger.info(
      { host: input.host, port: resolveListeningPort(server, input.port) },
      "Relay-channel control plane listening"
    );
    input.onStateChange?.(getState());
  });

  server.on("close", () => {
    listening = false;
    input.onStateChange?.(getState());
  });

  server.listen(input.port, input.host);

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const pathname = new URL(
        req.url ?? "/",
        `http://${input.host}:${resolveListeningPort(server, input.port)}`
      ).pathname;
      if (req.method === "POST" && pathname === "/hello") {
        const hello = helloRequestSchema.parse(await readJsonBody(req));
        lastAccountId = hello.accountId;
        clientConnected = true;
        input.onStateChange?.(getState());
        const dp = input.getDataPlane();
        sendJson(
          res,
          200,
          buildHelloResponse({
            relayInstanceId: input.relayInstanceId,
            accountId: hello.accountId,
            requestedCapabilities: hello.requestedCapabilities,
            dataPlane: {
              uploadBaseUrl: dp.uploadBaseUrl,
              downloadBaseUrl: dp.downloadBaseUrl,
            },
          })
        );
        return;
      }

      if (req.method === "POST" && pathname === "/actions") {
        const request = transportActionRequestSchema.parse(await readJsonBody(req));
        const result = await executeTransportAction({
          action: request.action,
          backend: input.backend,
          getDataPlane: input.getDataPlane,
        });
        clientConnected = true;
        input.onStateChange?.(getState());
        sendJson(
          res,
          200,
          buildActionCompleted({
            requestId: request.requestId,
            actionId: request.action.actionId,
            result,
          })
        );
        return;
      }

      sendJson(
        res,
        404,
        buildProtocolError({
          code: "UNKNOWN_ROUTE",
          message: `${req.method ?? "GET"} ${pathname} is not supported`,
        })
      );
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Relay-channel control plane request error"
      );
      sendJson(
        res,
        400,
        buildProtocolError({
          code: "INVALID_REQUEST",
          message: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  function scheduleEventDrain(delayMs: number) {
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drainPendingEvents();
    }, delayMs);
  }

  async function drainPendingEvents() {
    if (closed || processingEvents) {
      return;
    }
    processingEvents = true;
    try {
      while (pendingEvents.length > 0 && !closed) {
        const next = pendingEvents[0];
        try {
          await postEventToPlugin({
            host: input.host,
            relayPort: resolveListeningPort(server, input.port),
            event: next.event,
          });
          pendingEvents.shift();
          clientConnected = true;
          input.onStateChange?.(getState());
        } catch (error) {
          next.attempt += 1;
          next.lastError = error instanceof Error ? error.message : String(error);
          clientConnected = false;
          input.onStateChange?.(getState());
          if (next.attempt >= MAX_EVENT_DELIVERY_ATTEMPTS) {
            logger.error(
              {
                eventType: readEventType(next.event),
                attempts: next.attempt,
                error: next.lastError,
              },
              "Dropping relay-channel event after exhausting local HTTP retries"
            );
            pendingEvents.shift();
            continue;
          }
          logger.warn(
            {
              eventType: readEventType(next.event),
              attempts: next.attempt,
              error: next.lastError,
              retryInMs: EVENT_DELIVERY_RETRY_MS,
            },
            "Relay-channel event delivery failed; retry scheduled"
          );
          scheduleEventDrain(EVENT_DELIVERY_RETRY_MS);
          return;
        }
      }
    } finally {
      processingEvents = false;
    }
  }

  function enqueueEvent(event: Record<string, unknown>) {
    const normalized = structuredClone(event);
    const coalescingKey = getCoalescingKey(normalized);
    if (coalescingKey) {
      const existing = pendingEvents.find((entry) => entry.coalescingKey === coalescingKey);
      if (existing) {
        existing.event = normalized;
        existing.attempt = 0;
        existing.lastError = null;
        void drainPendingEvents();
        return;
      }
    }

    const textMergeKey = getTextMergeKey(normalized);
    if (textMergeKey) {
      const existing = pendingEvents.find((entry) => entry.textMergeKey === textMergeKey);
      if (existing) {
        existing.event = mergeTextOnlyInboundEvents(existing.event, normalized);
        existing.attempt = 0;
        existing.lastError = null;
        void drainPendingEvents();
        return;
      }
    }

    pendingEvents.push({
      event: normalized,
      attempt: 0,
      coalescingKey,
      textMergeKey,
      lastError: null,
    });
    void drainPendingEvents();
  }

  return {
    server,
    getState,
    publishEvent: (event) => {
      enqueueEvent(event);
    },
    close: async () => {
      closed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function executeTransportAction(input: {
  action: ReturnType<typeof transportActionRequestSchema.parse>["action"];
  backend: BackendClient;
  getDataPlane: () => {
    uploadBaseUrl: string;
    downloadBaseUrl: string;
    registerDownload: (input: {
      body: Buffer;
      contentType: string;
      fileName: string;
      expiresAtMs?: number;
      token?: string;
    }) => { token: string; downloadUrl: string };
  };
}) {
  const channel = input.action.transportTarget.channel;
  const result =
    channel === "telegram"
      ? await (async () => {
          const dataPlane = input.getDataPlane();
          return await executeTelegramTransportActionViaBackend({
            backend: input.backend,
            action: input.action,
            registerDownload: (download) => dataPlane.registerDownload(download),
          });
        })()
      : channel === "whatsapp_personal"
        ? input.action.kind === "message.send"
          ? await executeWhatsAppPersonalMessageSend({
              backend: input.backend,
              action: input.action,
            })
          : (() => {
              throw new Error(`UNSUPPORTED_TRANSPORT_ACTION: ${input.action.kind}`);
            })()
        : (() => {
            throw new Error(`UNSUPPORTED_TRANSPORT_CHANNEL: ${channel ?? "unknown"}`);
          })();

  const completedResult = {
    transportMessageId:
      "transportMessageId" in result && typeof result.transportMessageId === "string"
        ? result.transportMessageId
        : `relay_${randomUUID()}`,
    ...("conversationId" in result && typeof result.conversationId === "string"
      ? { conversationId: result.conversationId }
      : {}),
    ...("threadId" in result && typeof result.threadId === "string" ? { threadId: result.threadId } : {}),
    ...("uploadUrl" in result && typeof result.uploadUrl === "string" ? { uploadUrl: result.uploadUrl } : {}),
    ...("downloadUrl" in result && typeof result.downloadUrl === "string"
      ? { downloadUrl: result.downloadUrl }
      : {}),
    ...("token" in result && typeof result.token === "string" ? { token: result.token } : {}),
  };

  if (
    channel === "telegram" &&
    typeof input.action.transportTarget.chatId === "string" &&
    input.action.transportTarget.chatId.trim().length > 0 &&
    typeof completedResult.transportMessageId === "string"
  ) {
    const threadId =
      ("threadId" in result && typeof result.threadId === "string"
        ? result.threadId
        : typeof input.action.thread?.threadId === "string"
          ? input.action.thread.threadId
          : null) ?? null;
    await input.backend.registerTelegramMessageCorrelation({
      chatId: input.action.transportTarget.chatId,
      transportMessageId: completedResult.transportMessageId,
      conversationHandle: input.action.conversation.handle ?? input.action.transportTarget.chatId,
      threadHandle: input.action.thread?.handle ?? threadId,
    });
  }

  return completedResult;
}

async function postEventToPlugin(input: {
  host: string;
  relayPort: number;
  event: Record<string, unknown>;
}) {
  const response = await fetch(resolvePluginEventEndpoint(input), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input.event),
  });
  if (!response.ok) {
    throw new Error(`Plugin ingress returned HTTP ${response.status}`);
  }
}

function resolvePluginEventEndpoint(input: {
  host: string;
  relayPort: number;
  event: Record<string, unknown>;
}): string {
  const eventType = readEventType(input.event);
  const eventPath =
    eventType === "transport.message.received"
      ? "/events/message-received"
      : eventType === "transport.capabilities.updated"
        ? "/events/capabilities"
        : eventType.startsWith("transport.account.")
          ? "/events/account-status"
          : "/events/transport-event";
  return `http://${input.host}:${input.relayPort + PLUGIN_EVENT_PORT_OFFSET}${eventPath}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(String(chunk))
    );
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? (JSON.parse(text) as unknown) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function resolveListeningPort(server: ReturnType<typeof createServer>, fallbackPort: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallbackPort;
}

function getCoalescingKey(event: Record<string, unknown>): string | null {
  const eventType = readEventType(event);
  if (
    eventType === "transport.typing.updated" ||
    eventType === "transport.capabilities.updated" ||
    eventType.startsWith("transport.account.")
  ) {
    return `${eventType}:${readAccountId(event) ?? "unknown"}`;
  }
  return null;
}

function getTextMergeKey(event: Record<string, unknown>): string | null {
  if (readEventType(event) !== "transport.message.received") {
    return null;
  }
  const payload = readPayload(event);
  const message = isRecord(payload.message) ? payload.message : null;
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!text || attachments.length > 0) {
    return null;
  }
  const conversation = isRecord(payload.conversation) ? payload.conversation : {};
  const thread = isRecord(payload.thread) ? payload.thread : {};
  return [
    readOptionalString(payload.accountId) ?? "unknown",
    readOptionalString(conversation.handle) ??
      readOptionalString(conversation.transportConversationId) ??
      "unknown",
    readOptionalString(thread.threadId) ?? readOptionalString(thread.handle) ?? "",
  ].join(":");
}

function mergeTextOnlyInboundEvents(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const currentPayload = readPayload(current);
  const incomingPayload = readPayload(incoming);
  const currentMessage = isRecord(currentPayload.message) ? currentPayload.message : {};
  const incomingMessage = isRecord(incomingPayload.message) ? incomingPayload.message : {};
  return {
    ...current,
    ...incoming,
    payload: {
      ...currentPayload,
      ...incomingPayload,
      eventId: randomUUID(),
      cursor: readOptionalString(incomingPayload.cursor) ?? readOptionalString(currentPayload.cursor),
      message: {
        ...currentMessage,
        ...incomingMessage,
        transportMessageId:
          readOptionalString(incomingMessage.transportMessageId) ??
          readOptionalString(currentMessage.transportMessageId) ??
          randomUUID(),
        text: [formatMergedTextSegment(currentPayload), formatMergedTextSegment(incomingPayload)]
          .filter((segment) => segment.length > 0)
          .join("\n\n"),
        attachments: [],
      },
    },
  };
}

function formatMergedTextSegment(payload: Record<string, unknown>): string {
  const message = isRecord(payload.message) ? payload.message : {};
  const text = typeof message?.text === "string" ? message.text.trim() : "";
  if (!text) {
    return "";
  }
  return `[merged inbound message id=${readOptionalString(message.transportMessageId) ?? "unknown"} cursor=${readOptionalString(payload.cursor) ?? "unknown"}]\n${text}`;
}

function readEventType(event: Record<string, unknown>): string {
  return typeof event.eventType === "string" ? event.eventType : "unknown";
}

function readAccountId(event: Record<string, unknown>): string | null {
  const payload = readPayload(event);
  return readOptionalString(payload.accountId);
}

function readPayload(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event.payload) ? event.payload : {};
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
