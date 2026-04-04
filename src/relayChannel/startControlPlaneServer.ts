import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { type BackendClient } from "../backend/backendClient.js";
import { logger } from "../logger.js";
import {
  buildActionAccepted,
  buildActionCompleted,
  buildHelloResponse,
  buildProtocolError,
  helloRequestSchema,
  transportActionRequestSchema,
} from "./controlPlaneProtocol.js";
import { executeTelegramTransportAction } from "./telegramTransport.js";
import { executeWhatsAppPersonalMessageSend } from "./whatsappPersonalTransport.js";

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
  wss: WebSocketServer;
  getState: () => ControlPlaneRuntimeState;
  publishEvent: (event: Record<string, unknown>) => void;
  close: () => Promise<void>;
} {
  let lastAccountId: string | null = null;
  let closed = false;

  const wss = new WebSocketServer({ host: input.host, port: input.port });
  const getState = (): ControlPlaneRuntimeState => ({
    enabled: true,
    listening: !closed,
    host: input.host,
    port: input.port,
    clientConnected: [...wss.clients].some((c) => c.readyState === WebSocket.OPEN),
    lastAccountId,
  });

  wss.on("listening", () => {
    logger.info(
      { host: input.host, port: input.port },
      "Relay-channel control plane listening"
    );
  });

  wss.on("connection", (socket: WebSocket) => {
    let helloDone = false;
    input.onStateChange?.(getState());

    const sendJson = (obj: Record<string, unknown>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
      }
    };

    socket.on("message", (raw) => {
      try {
        const text =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : "";
        const data = JSON.parse(text) as unknown;
        if (!helloDone) {
          const hello = helloRequestSchema.parse(data);
          lastAccountId = hello.accountId;
          helloDone = true;
          const dp = input.getDataPlane();
          sendJson(
            buildHelloResponse({
              relayInstanceId: input.relayInstanceId,
              accountId: hello.accountId,
              dataPlane: {
                uploadBaseUrl: dp.uploadBaseUrl,
                downloadBaseUrl: dp.downloadBaseUrl,
              },
            })
          );
          return;
        }

        const req = transportActionRequestSchema.parse(data);
        const { requestId, action } = req;
        sendJson(buildActionAccepted({ requestId, actionId: action.actionId }));
        void (async () => {
          try {
            const channel = action.transportTarget.channel;
            const result =
              channel === "telegram"
                ? await (async () => {
                    const transportConfig = await input.backend.getTelegramTransportConfig();
                    const dataPlane = input.getDataPlane();
                    return await executeTelegramTransportAction({
                      accessKey: transportConfig.accessKey,
                      apiBaseUrl: transportConfig.apiBaseUrl,
                      fileBaseUrl: transportConfig.fileBaseUrl,
                      action,
                      registerDownload: (download) => dataPlane.registerDownload(download),
                    });
                  })()
                : channel === "whatsapp_personal"
                  ? action.kind === "message.send"
                    ? await executeWhatsAppPersonalMessageSend({
                        backend: input.backend,
                        action,
                      })
                    : (() => {
                        throw new Error(`UNSUPPORTED_TRANSPORT_ACTION: ${action.kind}`);
                      })()
                  : (() => {
                      throw new Error(`UNSUPPORTED_TRANSPORT_CHANNEL: ${channel ?? "unknown"}`);
                    })();
            const completedResult = {
              transportMessageId:
                "transportMessageId" in result && typeof result.transportMessageId === "string"
                  ? result.transportMessageId
                  : `relay_${randomUUID()}`,
              ...("conversationId" in result &&
              typeof result.conversationId === "string"
                ? { conversationId: result.conversationId }
                : {}),
              ...("threadId" in result && typeof result.threadId === "string"
                ? { threadId: result.threadId }
                : {}),
              ...("uploadUrl" in result && typeof result.uploadUrl === "string"
                ? { uploadUrl: result.uploadUrl }
                : {}),
              ...("downloadUrl" in result &&
              typeof result.downloadUrl === "string"
                ? { downloadUrl: result.downloadUrl }
                : {}),
              ...("token" in result && typeof result.token === "string"
                ? { token: result.token }
                : {}),
            };
            sendJson(
              buildActionCompleted({
                requestId,
                actionId: action.actionId,
                result: completedResult,
              })
            );
          } catch (error) {
            sendJson({
              type: "event",
              eventType: "transport.action.failed",
              payload: {
                requestId,
                actionId: action.actionId,
                error: {
                  code: "TRANSPORT_ACTION_FAILED",
                  message: error instanceof Error ? error.message : String(error),
                  retryable: false,
                },
              },
            });
          }
        })();
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "Relay-channel control plane message error"
        );
        sendJson(
          buildProtocolError({
            code: "INVALID_FRAME",
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    });
    socket.on("close", () => {
      input.onStateChange?.(getState());
    });
  });

  return {
    wss,
    getState,
    publishEvent: (event) => {
      const payload = JSON.stringify(event);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    },
    close: async () => {
      closed = true;
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
