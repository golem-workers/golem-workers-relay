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

  it("uses a twelve-hour task timeout by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.taskTimeoutMs).toBe(43_200_000);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_TASK_TIMEOUT_MS: "45000",
    });
    expect(custom.taskTimeoutMs).toBe(45_000);
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

  it("uses a 10x gateway tick timeout multiplier by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.openclaw.tickTimeoutMultiplier).toBe(10);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_OPENCLAW_TICK_TIMEOUT_MULTIPLIER: "25",
    });
    expect(custom.openclaw.tickTimeoutMultiplier).toBe(25);
  });

  it("uses explicit provider-proxy backend prefixes by default", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });

    expect(cfg.openrouterProxy.pathPrefix).toBe("/provider-proxy/openrouter");
    expect(cfg.openrouterProxy.backendPathPrefix).toBe("/api/v1/relays/openrouter");
    expect(cfg.openaiProxy.pathPrefix).toBe("/provider-proxy/openai");
    expect(cfg.openaiProxy.backendPathPrefix).toBe("/api/v1/relays/openai");
    expect(cfg.jinaProxy.pathPrefix).toBe("/provider-proxy/jina");
    expect(cfg.jinaProxy.backendPathPrefix).toBe("/api/v1/relays/jina");
    expect(cfg.googleAiProxy.pathPrefix).toBe("/provider-proxy/google-ai");
    expect(cfg.googleAiProxy.backendPathPrefix).toBe("/api/v1/relays/google-ai");
    expect(cfg.elevenlabsProxy.pathPrefix).toBe("/provider-proxy/elevenlabs");
    expect(cfg.elevenlabsProxy.backendPathPrefix).toBe("/api/v1/relays/elevenlabs");
    expect(cfg.falProxy.pathPrefix).toBe("/provider-proxy/fal");
    expect(cfg.falProxy.backendPathPrefix).toBe("/api/v1/relays/fal");
    expect(cfg.runwayProxy.pathPrefix).toBe("/provider-proxy/runway");
    expect(cfg.runwayProxy.backendPathPrefix).toBe("/api/v1/relays/runway");
    expect(cfg.moonshotProxy.pathPrefix).toBe("/provider-proxy/moonshot");
    expect(cfg.moonshotProxy.backendPathPrefix).toBe("/api/v1/relays/moonshot");
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

  it("uses release-coupled relay-channel plugin auto-update defaults", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });

    expect(cfg.relayChannel.plugin.autoUpdateEnabled).toBe(true);
    expect(cfg.relayChannel.plugin.repoDir).toBe("/root/golem-workers-openclaw-channel-plugin");
    expect(cfg.relayChannel.plugin.repoUrl).toBe(
      "https://github.com/golem-workers/golem-workers-openclaw-channel-plugin.git"
    );
    expect(cfg.relayChannel.plugin.gitRef).toBe("release");
  });

  it("allows explicit relay-channel plugin runtime update overrides", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      APP_GIT_REF: "main",
      RELAY_CHANNEL_PLUGIN_AUTO_UPDATE_ENABLED: "0",
      RELAY_CHANNEL_PLUGIN_REPO_DIR: "/srv/plugin",
      RELAY_CHANNEL_PLUGIN_REPO_URL: "git@github.com:golem-workers/golem-workers-openclaw-channel-plugin.git",
      RELAY_CHANNEL_PLUGIN_GIT_REF: "feature/channel-plugin",
    });

    expect(cfg.relayChannel.plugin.autoUpdateEnabled).toBe(false);
    expect(cfg.relayChannel.plugin.repoDir).toBe("/srv/plugin");
    expect(cfg.relayChannel.plugin.repoUrl).toBe(
      "git@github.com:golem-workers/golem-workers-openclaw-channel-plugin.git"
    );
    expect(cfg.relayChannel.plugin.gitRef).toBe("feature/channel-plugin");
  });
});

