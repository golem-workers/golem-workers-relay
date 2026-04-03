import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../logger.js";
import {
  buildActionAccepted,
  buildActionCompleted,
  buildHelloResponse,
  buildProtocolError,
  helloRequestSchema,
  transportActionRequestSchema,
} from "./controlPlaneProtocol.js";

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
  getDataPlaneUrls: () => { uploadBaseUrl: string; downloadBaseUrl: string };
}): {
  wss: WebSocketServer;
  getState: () => ControlPlaneRuntimeState;
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
          const dp = input.getDataPlaneUrls();
          sendJson(
            buildHelloResponse({
              relayInstanceId: input.relayInstanceId,
              accountId: hello.accountId,
              dataPlane: dp,
            })
          );
          return;
        }

        const req = transportActionRequestSchema.parse(data);
        const { requestId, action } = req;
        sendJson(buildActionAccepted({ requestId, actionId: action.actionId }));
        sendJson(
          buildActionCompleted({
            requestId,
            actionId: action.actionId,
            transportMessageId: `stub_${randomUUID()}`,
          })
        );
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
  });

  return {
    wss,
    getState,
    close: async () => {
      closed = true;
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
