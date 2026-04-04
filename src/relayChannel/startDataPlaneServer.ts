import http from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { logger } from "../logger.js";

export type DataPlaneServerState = {
  listening: boolean;
  uploadBaseUrl: string;
  downloadBaseUrl: string;
};

type DownloadEntry = {
  body: Buffer;
  contentType: string;
  fileName: string;
  expiresAtMs: number;
};

export function startRelayChannelDataPlaneServer(input: {
  host: string;
  port: number;
}): {
  server: http.Server;
  getState: () => DataPlaneServerState;
  registerDownload: (input: {
    body: Buffer;
    contentType: string;
    fileName: string;
    expiresAtMs?: number;
    token?: string;
  }) => { token: string; downloadUrl: string };
} {
  const base = `http://${input.host}:${input.port}`;
  const uploadBaseUrl = `${base}/v1/upload`;
  const downloadBaseUrl = `${base}/v1/download`;
  const downloads = new Map<string, DownloadEntry>();

  const pruneExpiredDownloads = (nowMs: number) => {
    for (const [token, entry] of downloads.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        downloads.delete(token);
      }
    }
  };

  const sanitizeFileName = (raw: string) => {
    const value = raw.trim();
    if (!value) {
      return "attachment.bin";
    }
    return path.basename(value);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    pruneExpiredDownloads(Date.now());
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/v1/download/")) {
      const token = url.pathname.slice("/v1/download/".length).trim();
      const entry = downloads.get(token);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "DOWNLOAD_NOT_FOUND", message: "Download token not found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": entry.contentType,
        "content-length": String(entry.body.byteLength),
        "content-disposition": `attachment; filename="${sanitizeFileName(entry.fileName)}"`,
      });
      res.end(entry.body);
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
    registerDownload: (download) => {
      const token = download.token?.trim() || randomUUID();
      downloads.set(token, {
        body: download.body,
        contentType: download.contentType.trim() || "application/octet-stream",
        fileName: sanitizeFileName(download.fileName),
        expiresAtMs: download.expiresAtMs ?? Date.now() + 10 * 60_000,
      });
      return {
        token,
        downloadUrl: `${downloadBaseUrl}/${token}`,
      };
    },
  };
}

export async function closeHttpServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
