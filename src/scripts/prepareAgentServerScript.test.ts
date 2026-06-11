import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const prepareAgentServerScriptPath = resolve(process.cwd(), "scripts/prepare-agent-server.sh");

describe("prepare-agent-server snapshot preparation", () => {
  it("bakes Google Meet browser and PulseAudio dependencies into provider snapshots", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain("xvfb \\");
    expect(script).toContain("pulseaudio \\");
    expect(script).toContain("pulseaudio-utils \\");
    expect(script).toContain("google-chrome-stable_current_amd64.deb");
    expect(script).toContain("https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb");
    expect(script).toContain("google-chrome-stable --version");
    expect(script).toContain("command -v Xvfb");
    expect(script).toContain("command -v pulseaudio");
    expect(script).toContain("command -v pactl");
    expect(script).toContain("command -v parec");
    expect(script).toContain("command -v pacat");
  });
});
