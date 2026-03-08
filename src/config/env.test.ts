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

  it("uses near-zero debounce by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.chatBatchDebounceMs).toBe(1);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_CHAT_BATCH_DEBOUNCE_MS: "7500",
    });
    expect(custom.chatBatchDebounceMs).toBe(7500);
  });

  it("derives OpenRouter STT base URL from the local proxy by default", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_OPENROUTER_PROXY_PORT: "19090",
      RELAY_OPENROUTER_PROXY_PATH_PREFIX: "/or/v1",
    });

    expect(cfg.stt.baseUrl).toBe("http://127.0.0.1:19090/or/v1");
    expect(cfg.stt.model).toBe("openrouter/openai/gpt-audio-mini");
  });

  it("allows explicit OpenRouter STT overrides", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      OPENROUTER_STT_BASE_URL: "https://relay.example.com/audio/",
      OPENROUTER_STT_MODEL: "openrouter/custom/audio-model",
      STT_TIMEOUT_MS: "20000",
    });

    expect(cfg.stt.baseUrl).toBe("https://relay.example.com/audio");
    expect(cfg.stt.model).toBe("openrouter/custom/audio-model");
    expect(cfg.stt.timeoutMs).toBe(20_000);
  });
});

