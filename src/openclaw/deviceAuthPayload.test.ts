import { describe, expect, it } from "vitest";
import { buildDeviceAuthPayload } from "./deviceAuthPayload.js";

describe("buildDeviceAuthPayload", () => {
  it("builds v2 payload with sorted scopes and nonce", () => {
    const out = buildDeviceAuthPayload({
      deviceId: "dev",
      clientId: "gateway-client",
      clientMode: "backend",
      role: "operator",
      scopes: ["b", "a", "a"],
      signedAtMs: 123,
      token: "tok",
      nonce: "n1",
    });
    expect(out).toBe("v2|dev|gateway-client|backend|operator|a,b|123|tok|n1");
  });
});

