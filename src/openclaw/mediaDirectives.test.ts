import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectTranscriptArtifacts, collectTranscriptMedia } from "./mediaDirectives.js";

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

  it("recovers a missing MEDIA path by exact file name when there is a single candidate", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-recover-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    await fs.mkdir(path.join(workspaceRoot, "files"), { recursive: true });
    const videoPath = path.join(workspaceRoot, "files", "final_ytp.mp4");
    const videoBuf = Buffer.from("fake-mp4-data", "utf8");
    await fs.writeFile(videoPath, videoBuf);

    const report = await collectTranscriptArtifacts({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "retrying\nMEDIA: cyber_yytp/final_ytp.mp4" }],
      },
    });

    expect(report.artifacts).toHaveLength(1);
    expect(report.artifacts[0]?.path).toBe("files/final_ytp.mp4");
    expect(report.recoveredCount).toBe(1);
    expect(report.unresolved).toEqual([]);
  });

  it("does not guess when multiple exact file-name candidates exist", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-media-ambiguous-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    const workspaceRoot = path.join(stateDir, "workspace");
    await fs.mkdir(path.join(workspaceRoot, "a"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "b"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "a", "final_ytp.mp4"), "one", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "b", "final_ytp.mp4"), "two", "utf8");

    const report = await collectTranscriptArtifacts({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "retrying\nMEDIA: cyber_yytp/final_ytp.mp4" }],
      },
    });

    expect(report.artifacts).toEqual([]);
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]?.reason).toBe("ambiguous_file_name");
    expect(report.unresolved[0]?.candidatePaths).toEqual(["a/final_ytp.mp4", "b/final_ytp.mp4"]);
  });
});

