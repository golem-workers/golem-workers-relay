import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectTranscriptMedia } from "./mediaDirectives.js";

describe("collectTranscriptMedia", () => {
  it("collects MEDIA from absolute stateDir path", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const mediaDir = path.join(stateDir, "media", "browser");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });

    const imageAbsPath = path.join(mediaDir, "shot.png");
    const imageBuf = Buffer.from("fake-png-data", "utf8");
    await fs.writeFile(imageAbsPath, imageBuf);

    const sessionKey = "tg:chat:server";
    const sessionId = "sess-media-abs";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const sessionsMap = {
      [`agent:main:${sessionKey}`]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    };
    await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(sessionsMap), "utf8");

    const transcriptLine = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `screenshot\nMEDIA:${imageAbsPath}`,
          },
        ],
      },
    });
    await fs.writeFile(sessionFile, `${transcriptLine}\n`, "utf8");

    const media = await collectTranscriptMedia({ sessionKey });
    expect(media).toHaveLength(1);
    expect(media[0]?.fileName).toBe("shot.png");
    expect(media[0]?.contentType).toBe("image/png");
    expect(media[0]?.dataB64).toBe(imageBuf.toString("base64"));
    expect(media[0]?.path).toBe("media/browser/shot.png");
  });

  it("finds latest assistant message that contains MEDIA directives", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-history-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const mediaDir = path.join(stateDir, "media", "browser");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });

    const imageAbsPath = path.join(mediaDir, "shot2.png");
    const imageBuf = Buffer.from("fake-png-data-2", "utf8");
    await fs.writeFile(imageAbsPath, imageBuf);

    const sessionKey = "tg:chat:server2";
    const sessionId = "sess-media-history";
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    const sessionsMap = {
      [`agent:main:${sessionKey}`]: {
        sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    };
    await fs.writeFile(path.join(sessionsDir, "sessions.json"), JSON.stringify(sessionsMap), "utf8");

    const withMedia = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `here\nMEDIA:${imageAbsPath}` }],
      },
    });
    const withoutMedia = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "sent above, can you see it?" }],
      },
    });
    await fs.writeFile(sessionFile, `${withMedia}\n${withoutMedia}\n`, "utf8");

    const media = await collectTranscriptMedia({ sessionKey });
    expect(media).toHaveLength(1);
    expect(media[0]?.fileName).toBe("shot2.png");
    expect(media[0]?.dataB64).toBe(imageBuf.toString("base64"));
  });
});

