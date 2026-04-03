import http from "node:http";
import { logger } from "../logger.js";

export type DataPlaneServerState = {
  listening: boolean;
  uploadBaseUrl: string;
  downloadBaseUrl: string;
};

export function startRelayChannelDataPlaneServer(input: {
  host: string;
  port: number;
}): { server: http.Server; getState: () => DataPlaneServerState } {
  const base = `http://${input.host}:${input.port}`;
  const uploadBaseUrl = `${base}/v1/upload`;
  const downloadBaseUrl = `${base}/v1/download`;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("listening", () => {
    logger.info(
      { host: input.host, port: input.port },
      "Relay-channel data plane listening"
    );
  });

  server.listen(input.port, input.host);

  return {
    server,
    getState: () => ({
      listening: server.listening,
      uploadBaseUrl,
      downloadBaseUrl,
    }),
  };
}

export async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
