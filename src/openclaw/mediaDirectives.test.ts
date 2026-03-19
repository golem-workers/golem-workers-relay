import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectTranscriptMedia } from "./mediaDirectives.js";

describe("collectTranscriptMedia", () => {
  it("collects MEDIA from the current reply message", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const mediaDir = path.join(stateDir, "media", "browser");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });

    const imageAbsPath = path.join(mediaDir, "shot.png");
    const imageBuf = Buffer.from("fake-png-data", "utf8");
    await fs.writeFile(imageAbsPath, imageBuf);

    const media = await collectTranscriptMedia({
      message: {
        role: "assistant",
        content: [{ type: "text", text: `screenshot\nMEDIA:${imageAbsPath}` }],
      },
    });
    expect(media).toHaveLength(1);
    expect(media[0]?.fileName).toBe("shot.png");
    expect(media[0]?.contentType).toBe("image/png");
    expect(media[0]?.path).toBe("media/browser/shot.png");
    expect(media[0]?.sizeBytes).toBe(imageBuf.byteLength);
  });

  it("does not attach media when the current reply has no MEDIA directives", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-history-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    const mediaDir = path.join(stateDir, "media", "browser");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(mediaDir, { recursive: true });

    const imageAbsPath = path.join(mediaDir, "shot2.png");
    const imageBuf = Buffer.from("fake-png-data-2", "utf8");
    await fs.writeFile(imageAbsPath, imageBuf);

    const media = await collectTranscriptMedia({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "sent above, can you see it?" }],
      },
    });
    expect(imageBuf.byteLength).toBeGreaterThan(0);
    expect(media).toEqual([]);
  });
});

