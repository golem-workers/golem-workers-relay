import { describe, expect, it } from "vitest";

import { resolveCompatibleCodexPluginVersion } from "./resolve-openclaw-codex-plugin-version.mjs";

describe("resolveCompatibleCodexPluginVersion", () => {
  it("selects the newest numeric plugin revision for the same stable core release", () => {
    expect(
      resolveCompatibleCodexPluginVersion("2026.7.1-2", [
        "2026.7.1",
        "2026.7.1-1",
        "2026.7.1-beta.6",
        "2026.7.2-beta.1",
      ])
    ).toBe("2026.7.1-1");
  });

  it("does not select a plugin from a newer core release", () => {
    expect(
      resolveCompatibleCodexPluginVersion("2026.7.1-2", ["2026.7.1", "2026.7.2", "2026.7.2-3"])
    ).toBe("2026.7.1");
  });

  it("fails when no plugin exists for the stable core release", () => {
    expect(() => resolveCompatibleCodexPluginVersion("2026.7.1-2", ["2026.7.2"])).toThrow(
      "No @openclaw/codex version is compatible with OpenClaw 2026.7.1-2"
    );
  });
});
