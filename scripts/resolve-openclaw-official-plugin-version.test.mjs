import { describe, expect, it } from "vitest";

import { resolveCompatibleOfficialPluginVersion } from "./resolve-openclaw-official-plugin-version.mjs";

describe("resolveCompatibleOfficialPluginVersion", () => {
  it("selects the newest numeric revision from the matching core release", () => {
    expect(
      resolveCompatibleOfficialPluginVersion(
        "@openclaw/moonshot-provider",
        "2026.8.1-2",
        ["2026.8.1", "2026.8.1-1", "2026.8.1-beta.2", "2026.9.1"],
      ),
    ).toBe("2026.8.1-1");
  });

  it("supports another official package without crossing core releases", () => {
    expect(
      resolveCompatibleOfficialPluginVersion(
        "@openclaw/perplexity-plugin",
        "2026.8.1",
        ["2026.7.1-3", "2026.8.1", "2026.9.1"],
      ),
    ).toBe("2026.8.1");
  });

  it("rejects non-official packages", () => {
    expect(() =>
      resolveCompatibleOfficialPluginVersion("third-party/plugin", "2026.8.1", [
        "2026.8.1",
      ]),
    ).toThrow("Unsupported official OpenClaw plugin package");
  });

  it("fails when the package has no matching stable release", () => {
    expect(() =>
      resolveCompatibleOfficialPluginVersion(
        "@openclaw/moonshot-provider",
        "2026.8.1",
        ["2026.9.1"],
      ),
    ).toThrow(
      "No @openclaw/moonshot-provider version is compatible with OpenClaw 2026.8.1",
    );
  });
});
