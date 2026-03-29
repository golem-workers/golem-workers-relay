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

  it("uses 500ms debounce by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.chatBatchDebounceMs).toBe(500);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_CHAT_BATCH_DEBOUNCE_MS: "7500",
    });
    expect(custom.chatBatchDebounceMs).toBe(7500);
  });

  it("enables low disk alerts by default and allows threshold override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.lowDiskAlertEnabled).toBe(true);
    expect(def.lowDiskAlertThresholdPercent).toBe(80);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_LOW_DISK_ALERT_ENABLED: "0",
      RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT: "92",
    });
    expect(custom.lowDiskAlertEnabled).toBe(false);
    expect(custom.lowDiskAlertThresholdPercent).toBe(92);
  });

  it("enables final-only OpenClaw forwarding by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.openclawForwardFinalOnly).toBe(true);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_OPENCLAW_FORWARD_FINAL_ONLY: "0",
    });
    expect(custom.openclawForwardFinalOnly).toBe(false);
  });

  it("derives OpenAI STT base URL from the backend relay proxy by default", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });

    expect(cfg.stt.baseUrl).toBe("https://example.com/api/v1/relays/openai");
    expect(cfg.stt.model).toBe("gpt-4o-transcribe");
  });

  it("allows explicit OpenAI STT overrides", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      OPENAI_STT_BASE_URL: "https://relay.example.com/audio/",
      OPENAI_STT_MODEL: "gpt-4o-transcribe",
      STT_TIMEOUT_MS: "20000",
    });

    expect(cfg.stt.baseUrl).toBe("https://relay.example.com/audio");
    expect(cfg.stt.model).toBe("gpt-4o-transcribe");
    expect(cfg.stt.timeoutMs).toBe(20_000);
  });
});

