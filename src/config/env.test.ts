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
    expect(def.selfNudgeTaskTimeoutMs).toBe(43_200_000);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_TASK_TIMEOUT_MS: "45000",
    });
    expect(custom.taskTimeoutMs).toBe(45_000);
    expect(custom.selfNudgeTaskTimeoutMs).toBe(45_000);
  });

  it("processes relay messages concurrently by default and allows override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.concurrency).toBe(100);

    const derived = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_PUSH_MAX_CONCURRENT_REQUESTS: "250",
    });
    expect(derived.concurrency).toBe(250);

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_PUSH_MAX_CONCURRENT_REQUESTS: "250",
      RELAY_CONCURRENCY: "12",
    });
    expect(custom.concurrency).toBe(12);
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

  it("keeps relay diagnostic notifier disabled by default and allows env override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.diagnosticNotifier).toEqual({
      enabled: false,
      intervalMs: 300_000,
      lookbackMs: 300_000,
      throttleMs: 600_000,
      maxLines: 2_000,
      journalUserUnits: ["openclaw-gateway.service"],
      journalSystemUnits: ["golem-workers-relay.service"],
      logFiles: [],
      targetUserId: null,
    });

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_DIAGNOSTIC_NOTIFIER_ENABLED: "1",
      RELAY_DIAGNOSTIC_NOTIFIER_INTERVAL_MS: "120000",
      RELAY_DIAGNOSTIC_NOTIFIER_LOOKBACK_MS: "300000",
      RELAY_DIAGNOSTIC_NOTIFIER_THROTTLE_MS: "900000",
      RELAY_DIAGNOSTIC_NOTIFIER_MAX_LINES: "500",
      RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_USER_UNITS: "openclaw-gateway.service,other-user.service",
      RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_SYSTEM_UNITS: "golem-workers-relay.service",
      RELAY_DIAGNOSTIC_NOTIFIER_LOG_FILES: "/var/log/golem-workers/prepare-agent-server.log",
      RELAY_DIAGNOSTIC_NOTIFIER_USER_ID: "user_1",
    });
    expect(custom.diagnosticNotifier).toEqual({
      enabled: true,
      intervalMs: 120_000,
      lookbackMs: 300_000,
      throttleMs: 900_000,
      maxLines: 500,
      journalUserUnits: ["openclaw-gateway.service", "other-user.service"],
      journalSystemUnits: ["golem-workers-relay.service"],
      logFiles: ["/var/log/golem-workers/prepare-agent-server.log"],
      targetUserId: "user_1",
    });
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

  it("keeps self-nudge disabled by default and allows relay env override", () => {
    const def = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
    });
    expect(def.selfNudge).toEqual({
      enabled: false,
      analyzedRecentMessageCount: 0,
      baseTimeoutMs: 300_000,
      model: null,
      debugMessagesEnabled: false,
      nudgeNoticeEnabled: false,
      finalNoticeEnabled: false,
      finalNoticeText: "Final message.",
    });

    const custom = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      RELAY_SELF_NUDGE_ENABLED: "1",
      RELAY_SELF_NUDGE_ANALYZED_RECENT_MESSAGE_COUNT: "2",
      RELAY_SELF_NUDGE_BASE_TIMEOUT_MS: "600000",
      RELAY_SELF_NUDGE_TASK_TIMEOUT_MS: "7200000",
      RELAY_SELF_NUDGE_MODEL: "openrouter/google/gemini-2.5-flash",
      RELAY_SELF_NUDGE_FINAL_NOTICE_ENABLED: "1",
      RELAY_SELF_NUDGE_FINAL_NOTICE_TEXT: "Final reply detected.",
    });
    expect(custom.selfNudgeTaskTimeoutMs).toBe(7_200_000);
    expect(custom.selfNudge).toEqual({
      enabled: true,
      analyzedRecentMessageCount: 2,
      baseTimeoutMs: 600_000,
      model: "openrouter/google/gemini-2.5-flash",
      debugMessagesEnabled: false,
      nudgeNoticeEnabled: false,
      finalNoticeEnabled: true,
      finalNoticeText: "Final reply detected.",
    });
  });

  it("uses DEBUG_NUDGE to enable nudge-related debug messages", () => {
    const cfg = loadRelayConfig({
      RELAY_TOKEN: "t",
      BACKEND_BASE_URL: "https://example.com",
      DEBUG_NUDGE: "1",
    });

    expect(cfg.diagnosticNotifier.enabled).toBe(true);
    expect(cfg.selfNudge.debugMessagesEnabled).toBe(true);
    expect(cfg.selfNudge.nudgeNoticeEnabled).toBe(true);
    expect(cfg.selfNudge.finalNoticeEnabled).toBe(true);
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
