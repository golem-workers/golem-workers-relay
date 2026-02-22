import { describe, expect, it } from "vitest";
import { loadRelayConfig } from "./env.js";

describe("loadRelayConfig", () => {
  it("requires RELAY_TOKEN and BACKEND_BASE_URL", () => {
    expect(() =>
      loadRelayConfig({
        RELAY_TOKEN: "t",
        BACKEND_BASE_URL: "https://example.com",
      })
    ).not.toThrow();
  });

  it("disables dev log in production unless forced", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      NODE_ENV: "production",
      RELAY_DEV_LOG: "1",
    });
    expect(cfg.devLogEnabled).toBe(false);
    expect(cfg.devLogForce).toBe(false);
  });

  it("enables dev log in production when forced", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      NODE_ENV: "production",
      RELAY_DEV_LOG: "1",
      RELAY_DEV_LOG_FORCE: "1",
      RELAY_DEV_LOG_GATEWAY_FRAMES: "1",
    });
    expect(cfg.devLogEnabled).toBe(true);
    expect(cfg.devLogForce).toBe(true);
    expect(cfg.devLogGatewayFrames).toBe(true);
  });
});

