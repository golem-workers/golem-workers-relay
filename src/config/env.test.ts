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

  it("disables message flow log by default", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(cfg.devLogEnabled).toBe(false);
    expect(cfg.devLogGatewayFrames).toBe(false);
  });

  it("enables message flow log when MESSAGE_FLOW_LOG is set", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      NODE_ENV: "production",
      MESSAGE_FLOW_LOG: "1",
    });
    expect(cfg.devLogEnabled).toBe(true);
    expect(cfg.devLogGatewayFrames).toBe(false);
  });
});

