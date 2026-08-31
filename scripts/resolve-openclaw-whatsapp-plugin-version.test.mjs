import { describe, expect, it } from "vitest";

import { resolveCompatibleWhatsAppPluginVersion } from "./resolve-openclaw-whatsapp-plugin-version.mjs";

describe("resolveCompatibleWhatsAppPluginVersion", () => {
  it("selects the newest numeric plugin revision for the same stable core release", () => {
    expect(
      resolveCompatibleWhatsAppPluginVersion("2026.7.1-2", [
        "2026.7.1",
        "2026.7.1-1",
        "2026.7.1-beta.6",
        "2026.8.1",
      ])
    ).toBe("2026.7.1-1");
  });

  it("does not select a plugin from a newer core release", () => {
    expect(
      resolveCompatibleWhatsAppPluginVersion("2026.7.1-2", ["2026.7.1", "2026.8.1"])
    ).toBe("2026.7.1");
  });

  it("fails when no plugin exists for the stable core release", () => {
    expect(() => resolveCompatibleWhatsAppPluginVersion("2026.7.1-2", ["2026.8.1"])).toThrow(
      "No @openclaw/whatsapp version is compatible with OpenClaw 2026.7.1-2"
    );
  });
});
