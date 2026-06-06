import { z } from "zod";
import os from "node:os";

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const envBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  RELAY_TOKEN: z.string().min(1),
  BACKEND_BASE_URL: z.string().url(),

  APP_GIT_REF: z.string().min(1).optional(),
  RELAY_INSTANCE_ID: z.string().min(1).optional(),
  RELAY_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(2_147_483_647).optional(),
  RELAY_SYSTEM_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(2_147_483_647).optional(),
  RELAY_CHAT_BATCH_DEBOUNCE_MS: z.coerce.number().int().min(0).max(120_000).optional(),
  RELAY_LOW_DISK_ALERT_ENABLED: envBooleanSchema.optional(),
  RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT: z.coerce.number().min(1).max(100).optional(),
  DEBUG_NUDGE: envBooleanSchema.optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_ENABLED: envBooleanSchema.optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_LOOKBACK_MS: z.coerce.number().int().min(10_000).max(86_400_000).optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_THROTTLE_MS: z.coerce.number().int().min(10_000).max(86_400_000).optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_MAX_LINES: z.coerce.number().int().min(10).max(100_000).optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_USER_UNITS: z.string().optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_SYSTEM_UNITS: z.string().optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_LOG_FILES: z.string().optional(),
  RELAY_DIAGNOSTIC_NOTIFIER_USER_ID: z.string().optional(),
  RELAY_CONCURRENCY: z.coerce.number().int().min(1).max(10_000).optional(),
  RELAY_PUSH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_PUSH_PATH: z.string().min(1).optional(),
  RELAY_PUSH_RATE_LIMIT_PER_SEC: z.coerce.number().int().min(1).max(100_000).optional(),
  RELAY_PUSH_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(10_000).optional(),
  RELAY_PUSH_MAX_QUEUE: z.coerce.number().int().min(1).max(1_000_000).optional(),
  RELAY_OPENROUTER_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_OPENROUTER_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_OPENROUTER_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_OPENROUTER_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_OPENAI_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_OPENAI_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_OPENAI_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_OPENAI_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_JINA_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_JINA_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_JINA_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_JINA_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_GOOGLE_AI_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_GOOGLE_AI_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_GOOGLE_AI_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_GOOGLE_AI_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_ELEVENLABS_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_ELEVENLABS_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_ELEVENLABS_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_ELEVENLABS_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_FAL_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_FAL_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_FAL_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_FAL_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_RUNWAY_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_RUNWAY_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_RUNWAY_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_RUNWAY_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_MOONSHOT_PROXY_ENABLED: z.coerce.boolean().optional(),
  RELAY_MOONSHOT_PROXY_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_MOONSHOT_PROXY_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_MOONSHOT_BACKEND_PATH_PREFIX: z.string().min(1).optional(),
  RELAY_OPENCLAW_FORWARD_FINAL_ONLY: envBooleanSchema.optional(),
  RELAY_SELF_NUDGE_ENABLED: envBooleanSchema.optional(),
  RELAY_SELF_NUDGE_ANALYZED_RECENT_MESSAGE_COUNT: z.coerce.number().int().min(0).max(50).optional(),
  RELAY_SELF_NUDGE_BASE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(2_147_483_647).optional(),
  RELAY_SELF_NUDGE_MODEL: z.string().min(1).optional(),
  RELAY_SELF_NUDGE_FINAL_NOTICE_ENABLED: envBooleanSchema.optional(),
  RELAY_SELF_NUDGE_FINAL_NOTICE_TEXT: z.string().min(1).max(500).optional(),

  RELAY_CHANNEL_ENABLED: envBooleanSchema.optional(),
  RELAY_CHANNEL_CONTROL_PLANE_HOST: z.string().min(1).optional(),
  RELAY_CHANNEL_CONTROL_PLANE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_CHANNEL_DATA_PLANE_HOST: z.string().min(1).optional(),
  RELAY_CHANNEL_DATA_PLANE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_CHANNEL_PLUGIN_AUTO_UPDATE_ENABLED: envBooleanSchema.optional(),
  RELAY_CHANNEL_PLUGIN_REPO_DIR: z.string().min(1).optional(),
  RELAY_CHANNEL_PLUGIN_REPO_URL: z.string().min(1).optional(),
  RELAY_CHANNEL_PLUGIN_GIT_REF: z.string().min(1).optional(),

  MESSAGE_FLOW_LOG: z.coerce.boolean().optional(),

  OPENCLAW_GATEWAY_WS_URL: z.string().url().optional(),
  OPENCLAW_CONFIG_PATH: z.string().min(1).optional(),
  OPENCLAW_STATE_DIR: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_PASSWORD: z.string().min(1).optional(),
  OPENCLAW_SCOPES: z.string().optional(),
  RELAY_OPENCLAW_TICK_TIMEOUT_MULTIPLIER: z.coerce.number().min(1).max(1000).optional(),

  OPENAI_STT_BASE_URL: z.string().url().optional(),
  OPENAI_STT_MODEL: z.string().min(1).optional(),
  STT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).optional(),
});

export type RelayEnv = z.infer<typeof envSchema>;

export type RelayConfig = {
  relayToken: string;
  backendBaseUrl: string;
  relayInstanceId: string;
  taskTimeoutMs: number;
  systemTaskTimeoutMs: number;
  chatBatchDebounceMs: number;
  lowDiskAlertEnabled: boolean;
  lowDiskAlertThresholdPercent: number;
  diagnosticNotifier: {
    enabled: boolean;
    intervalMs: number;
    lookbackMs: number;
    throttleMs: number;
    maxLines: number;
    journalUserUnits: string[];
    journalSystemUnits: string[];
    logFiles: string[];
    targetUserId: string | null;
  };
  concurrency: number;
  pushPort: number;
  pushPath: string;
  pushRateLimitPerSecond: number;
  pushMaxConcurrentRequests: number;
  pushMaxQueue: number;
  openrouterProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  openaiProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  jinaProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  googleAiProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  elevenlabsProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  falProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  runwayProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  moonshotProxy: {
    enabled: boolean;
    port: number;
    pathPrefix: string;
    backendPathPrefix: string;
  };
  openclawForwardFinalOnly: boolean;
  selfNudge: {
    enabled: boolean;
    analyzedRecentMessageCount: number;
    baseTimeoutMs: number;
    model: string | null;
    debugMessagesEnabled: boolean;
    nudgeNoticeEnabled: boolean;
    finalNoticeEnabled: boolean;
    finalNoticeText: string;
  };
  devLogEnabled: boolean;
  devLogTextMaxLen: number;
  devLogGatewayFrames: boolean;
  openclaw: {
    gatewayWsUrl?: string;
    configPath?: string;
    stateDir?: string;
    token?: string;
    password?: string;
    scopes: string[];
    tickTimeoutMultiplier: number;
  };
  stt: {
    baseUrl: string;
    model: string;
    timeoutMs: number;
  };
  relayChannel: {
    enabled: boolean;
    controlPlaneHost: string;
    controlPlanePort: number;
    dataPlaneHost: string;
    dataPlanePort: number;
    plugin: {
      autoUpdateEnabled: boolean;
      repoDir: string;
      repoUrl: string;
      gitRef: string;
    };
  };
};

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = envSchema.parse(env) satisfies RelayEnv;
  const devLogEnabled = parsed.MESSAGE_FLOW_LOG ?? false;
  const devLogTextMaxLen = 200;
  const devLogGatewayFrames = false;

  const diagnosticNotifierIntervalMs = parsed.RELAY_DIAGNOSTIC_NOTIFIER_INTERVAL_MS ?? 300_000;
  const debugNudgeEnabled = parsed.DEBUG_NUDGE ?? false;
  const relayInstanceId =
    parsed.RELAY_INSTANCE_ID ||
    `${os.hostname()}-${process.pid}-${Math.random().toString(16).slice(2)}`;

  return {
    relayToken: parsed.RELAY_TOKEN,
    backendBaseUrl: parsed.BACKEND_BASE_URL.replace(/\/+$/, ""),
    relayInstanceId,
    taskTimeoutMs: parsed.RELAY_TASK_TIMEOUT_MS ?? 12 * 60 * 60_000,
    systemTaskTimeoutMs: parsed.RELAY_SYSTEM_TASK_TIMEOUT_MS ?? 120_000,
    chatBatchDebounceMs: parsed.RELAY_CHAT_BATCH_DEBOUNCE_MS ?? 500,
    lowDiskAlertEnabled: parsed.RELAY_LOW_DISK_ALERT_ENABLED ?? true,
    lowDiskAlertThresholdPercent: parsed.RELAY_LOW_DISK_ALERT_THRESHOLD_PERCENT ?? 80,
    diagnosticNotifier: {
      enabled: debugNudgeEnabled || (parsed.RELAY_DIAGNOSTIC_NOTIFIER_ENABLED ?? false),
      intervalMs: diagnosticNotifierIntervalMs,
      lookbackMs: parsed.RELAY_DIAGNOSTIC_NOTIFIER_LOOKBACK_MS ?? diagnosticNotifierIntervalMs,
      throttleMs: parsed.RELAY_DIAGNOSTIC_NOTIFIER_THROTTLE_MS ?? 600_000,
      maxLines: parsed.RELAY_DIAGNOSTIC_NOTIFIER_MAX_LINES ?? 2_000,
      journalUserUnits: parseCsv(parsed.RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_USER_UNITS) ?? [
        "openclaw-gateway.service",
      ],
      journalSystemUnits: parseCsv(parsed.RELAY_DIAGNOSTIC_NOTIFIER_JOURNAL_SYSTEM_UNITS) ?? [
        "golem-workers-relay.service",
      ],
      logFiles: parseCsv(parsed.RELAY_DIAGNOSTIC_NOTIFIER_LOG_FILES) ?? [],
      targetUserId: parsed.RELAY_DIAGNOSTIC_NOTIFIER_USER_ID?.trim() || null,
    },
    concurrency: parsed.RELAY_CONCURRENCY ?? parsed.RELAY_PUSH_MAX_CONCURRENT_REQUESTS ?? 100,
    pushPort: parsed.RELAY_PUSH_PORT ?? 18790,
    pushPath: parsed.RELAY_PUSH_PATH ?? "/relay/messages",
    pushRateLimitPerSecond: parsed.RELAY_PUSH_RATE_LIMIT_PER_SEC ?? 100,
    pushMaxConcurrentRequests: parsed.RELAY_PUSH_MAX_CONCURRENT_REQUESTS ?? 100,
    pushMaxQueue: parsed.RELAY_PUSH_MAX_QUEUE ?? 2000,
    openrouterProxy: {
      enabled: parsed.RELAY_OPENROUTER_PROXY_ENABLED ?? true,
      port: parsed.RELAY_OPENROUTER_PROXY_PORT ?? 18080,
      pathPrefix: withLeadingSlash(
        parsed.RELAY_OPENROUTER_PROXY_PATH_PREFIX ?? "/provider-proxy/openrouter"
      ),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_OPENROUTER_BACKEND_PATH_PREFIX ?? "/api/v1/relays/openrouter"
      ),
    },
    openaiProxy: {
      enabled: parsed.RELAY_OPENAI_PROXY_ENABLED ?? true,
      port: parsed.RELAY_OPENAI_PROXY_PORT ?? 18084,
      pathPrefix: withLeadingSlash(parsed.RELAY_OPENAI_PROXY_PATH_PREFIX ?? "/provider-proxy/openai"),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_OPENAI_BACKEND_PATH_PREFIX ?? "/api/v1/relays/openai"
      ),
    },
    jinaProxy: {
      enabled: parsed.RELAY_JINA_PROXY_ENABLED ?? true,
      port: parsed.RELAY_JINA_PROXY_PORT ?? 18082,
      pathPrefix: withLeadingSlash(parsed.RELAY_JINA_PROXY_PATH_PREFIX ?? "/provider-proxy/jina"),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_JINA_BACKEND_PATH_PREFIX ?? "/api/v1/relays/jina"
      ),
    },
    googleAiProxy: {
      enabled: parsed.RELAY_GOOGLE_AI_PROXY_ENABLED ?? true,
      port: parsed.RELAY_GOOGLE_AI_PROXY_PORT ?? 18081,
      pathPrefix: withLeadingSlash(
        parsed.RELAY_GOOGLE_AI_PROXY_PATH_PREFIX ?? "/provider-proxy/google-ai"
      ),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_GOOGLE_AI_BACKEND_PATH_PREFIX ?? "/api/v1/relays/google-ai"
      ),
    },
    elevenlabsProxy: {
      enabled: parsed.RELAY_ELEVENLABS_PROXY_ENABLED ?? true,
      port: parsed.RELAY_ELEVENLABS_PROXY_PORT ?? 18086,
      pathPrefix: withLeadingSlash(
        parsed.RELAY_ELEVENLABS_PROXY_PATH_PREFIX ?? "/provider-proxy/elevenlabs"
      ),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_ELEVENLABS_BACKEND_PATH_PREFIX ?? "/api/v1/relays/elevenlabs"
      ),
    },
    falProxy: {
      enabled: parsed.RELAY_FAL_PROXY_ENABLED ?? true,
      port: parsed.RELAY_FAL_PROXY_PORT ?? 18087,
      pathPrefix: withLeadingSlash(parsed.RELAY_FAL_PROXY_PATH_PREFIX ?? "/provider-proxy/fal"),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_FAL_BACKEND_PATH_PREFIX ?? "/api/v1/relays/fal"
      ),
    },
    runwayProxy: {
      enabled: parsed.RELAY_RUNWAY_PROXY_ENABLED ?? true,
      port: parsed.RELAY_RUNWAY_PROXY_PORT ?? 18085,
      pathPrefix: withLeadingSlash(parsed.RELAY_RUNWAY_PROXY_PATH_PREFIX ?? "/provider-proxy/runway"),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_RUNWAY_BACKEND_PATH_PREFIX ?? "/api/v1/relays/runway"
      ),
    },
    moonshotProxy: {
      enabled: parsed.RELAY_MOONSHOT_PROXY_ENABLED ?? true,
      port: parsed.RELAY_MOONSHOT_PROXY_PORT ?? 18083,
      pathPrefix: withLeadingSlash(
        parsed.RELAY_MOONSHOT_PROXY_PATH_PREFIX ?? "/provider-proxy/moonshot"
      ),
      backendPathPrefix: withLeadingSlash(
        parsed.RELAY_MOONSHOT_BACKEND_PATH_PREFIX ?? "/api/v1/relays/moonshot"
      ),
    },
    openclawForwardFinalOnly: parsed.RELAY_OPENCLAW_FORWARD_FINAL_ONLY ?? true,
    selfNudge: {
      enabled: parsed.RELAY_SELF_NUDGE_ENABLED ?? false,
      analyzedRecentMessageCount: parsed.RELAY_SELF_NUDGE_ANALYZED_RECENT_MESSAGE_COUNT ?? 0,
      baseTimeoutMs: parsed.RELAY_SELF_NUDGE_BASE_TIMEOUT_MS ?? 300_000,
      model: parsed.RELAY_SELF_NUDGE_MODEL?.trim() || null,
      debugMessagesEnabled: debugNudgeEnabled,
      nudgeNoticeEnabled: debugNudgeEnabled,
      finalNoticeEnabled: debugNudgeEnabled || (parsed.RELAY_SELF_NUDGE_FINAL_NOTICE_ENABLED ?? false),
      finalNoticeText: parsed.RELAY_SELF_NUDGE_FINAL_NOTICE_TEXT?.trim() || "Final message.",
    },
    devLogEnabled,
    devLogTextMaxLen,
    devLogGatewayFrames,
    openclaw: {
      gatewayWsUrl: parsed.OPENCLAW_GATEWAY_WS_URL,
      configPath: parsed.OPENCLAW_CONFIG_PATH,
      stateDir: parsed.OPENCLAW_STATE_DIR,
      token: parsed.OPENCLAW_GATEWAY_TOKEN,
      password: parsed.OPENCLAW_GATEWAY_PASSWORD,
      scopes: parseCsv(parsed.OPENCLAW_SCOPES) ?? ["operator.admin"],
      tickTimeoutMultiplier: parsed.RELAY_OPENCLAW_TICK_TIMEOUT_MULTIPLIER ?? 10,
    },
    stt: {
      baseUrl: (
        parsed.OPENAI_STT_BASE_URL ??
        `${parsed.BACKEND_BASE_URL.replace(/\/+$/, "")}/api/v1/relays/openai`
      ).replace(/\/+$/, ""),
      model: parsed.OPENAI_STT_MODEL ?? "gpt-4o-transcribe",
      timeoutMs: parsed.STT_TIMEOUT_MS ?? 15_000,
    },
    relayChannel: {
      enabled: parsed.RELAY_CHANNEL_ENABLED ?? true,
      controlPlaneHost: parsed.RELAY_CHANNEL_CONTROL_PLANE_HOST ?? "127.0.0.1",
      controlPlanePort: parsed.RELAY_CHANNEL_CONTROL_PLANE_PORT ?? 43_129,
      dataPlaneHost: parsed.RELAY_CHANNEL_DATA_PLANE_HOST ?? "127.0.0.1",
      dataPlanePort: parsed.RELAY_CHANNEL_DATA_PLANE_PORT ?? 43_130,
      plugin: {
        autoUpdateEnabled: parsed.RELAY_CHANNEL_PLUGIN_AUTO_UPDATE_ENABLED ?? true,
        repoDir: parsed.RELAY_CHANNEL_PLUGIN_REPO_DIR ?? "/root/golem-workers-openclaw-channel-plugin",
        repoUrl:
          parsed.RELAY_CHANNEL_PLUGIN_REPO_URL ??
          "https://github.com/golem-workers/golem-workers-openclaw-channel-plugin.git",
        gitRef: resolveDefaultRelayChannelPluginGitRef(parsed, env),
      },
    },
  };
}

// Back-compat helper for non-env sources (tests/mocks).
export function buildRelayConfigForTest(overrides: Partial<RelayConfig>): RelayConfig {
  const base: RelayConfig = {
    relayToken: "test",
    backendBaseUrl: "http://localhost:3000",
    relayInstanceId: "test-relay",
    taskTimeoutMs: 5000,
    systemTaskTimeoutMs: 120_000,
    chatBatchDebounceMs: 500,
    lowDiskAlertEnabled: true,
    lowDiskAlertThresholdPercent: 80,
    diagnosticNotifier: {
      enabled: false,
      intervalMs: 300_000,
      lookbackMs: 600_000,
      throttleMs: 600_000,
      maxLines: 2_000,
      journalUserUnits: ["openclaw-gateway.service"],
      journalSystemUnits: ["golem-workers-relay.service"],
      logFiles: [],
      targetUserId: null,
    },
    concurrency: 100,
    pushPort: 18790,
    pushPath: "/relay/messages",
    pushRateLimitPerSecond: 100,
    pushMaxConcurrentRequests: 100,
    pushMaxQueue: 2000,
    openrouterProxy: {
      enabled: true,
      port: 18080,
      pathPrefix: "/provider-proxy/openrouter",
      backendPathPrefix: "/api/v1/relays/openrouter",
    },
    openaiProxy: {
      enabled: true,
      port: 18084,
      pathPrefix: "/provider-proxy/openai",
      backendPathPrefix: "/api/v1/relays/openai",
    },
    jinaProxy: {
      enabled: true,
      port: 18082,
      pathPrefix: "/provider-proxy/jina",
      backendPathPrefix: "/api/v1/relays/jina",
    },
    googleAiProxy: {
      enabled: true,
      port: 18081,
      pathPrefix: "/provider-proxy/google-ai",
      backendPathPrefix: "/api/v1/relays/google-ai",
    },
    elevenlabsProxy: {
      enabled: true,
      port: 18086,
      pathPrefix: "/provider-proxy/elevenlabs",
      backendPathPrefix: "/api/v1/relays/elevenlabs",
    },
    falProxy: {
      enabled: true,
      port: 18087,
      pathPrefix: "/provider-proxy/fal",
      backendPathPrefix: "/api/v1/relays/fal",
    },
    runwayProxy: {
      enabled: true,
      port: 18085,
      pathPrefix: "/provider-proxy/runway",
      backendPathPrefix: "/api/v1/relays/runway",
    },
    moonshotProxy: {
      enabled: true,
      port: 18083,
      pathPrefix: "/provider-proxy/moonshot",
      backendPathPrefix: "/api/v1/relays/moonshot",
    },
    openclawForwardFinalOnly: true,
    selfNudge: {
      enabled: false,
      analyzedRecentMessageCount: 0,
      baseTimeoutMs: 300_000,
      model: null,
      debugMessagesEnabled: false,
      nudgeNoticeEnabled: false,
      finalNoticeEnabled: false,
      finalNoticeText: "Final message.",
    },
    devLogEnabled: false,
    devLogTextMaxLen: 200,
    devLogGatewayFrames: false,
    openclaw: { token: "test", scopes: ["operator.admin"], tickTimeoutMultiplier: 10 },
    stt: {
      baseUrl: "http://localhost:3000/api/v1/relays/openai",
      model: "gpt-4o-transcribe",
      timeoutMs: 15_000,
    },
    relayChannel: {
      enabled: false,
      controlPlaneHost: "127.0.0.1",
      controlPlanePort: 43_129,
      dataPlaneHost: "127.0.0.1",
      dataPlanePort: 43_130,
      plugin: {
        autoUpdateEnabled: true,
        repoDir: "/root/golem-workers-openclaw-channel-plugin",
        repoUrl: "https://github.com/golem-workers/golem-workers-openclaw-channel-plugin.git",
        gitRef: "release",
      },
    },
  };
  return {
    ...base,
    ...overrides,
    openrouterProxy: { ...base.openrouterProxy, ...(overrides.openrouterProxy ?? {}) },
    diagnosticNotifier: { ...base.diagnosticNotifier, ...(overrides.diagnosticNotifier ?? {}) },
    openaiProxy: { ...base.openaiProxy, ...(overrides.openaiProxy ?? {}) },
    jinaProxy: { ...base.jinaProxy, ...(overrides.jinaProxy ?? {}) },
    googleAiProxy: { ...base.googleAiProxy, ...(overrides.googleAiProxy ?? {}) },
    elevenlabsProxy: { ...base.elevenlabsProxy, ...(overrides.elevenlabsProxy ?? {}) },
    falProxy: { ...base.falProxy, ...(overrides.falProxy ?? {}) },
    runwayProxy: { ...base.runwayProxy, ...(overrides.runwayProxy ?? {}) },
    moonshotProxy: { ...base.moonshotProxy, ...(overrides.moonshotProxy ?? {}) },
    openclaw: { ...base.openclaw, ...(overrides.openclaw ?? {}) },
    stt: { ...base.stt, ...(overrides.stt ?? {}) },
    relayChannel: { ...base.relayChannel, ...(overrides.relayChannel ?? {}) },
  };
}

function withLeadingSlash(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function resolveDefaultRelayChannelPluginGitRef(parsed: RelayEnv, env: NodeJS.ProcessEnv): string {
  if (parsed.RELAY_CHANNEL_PLUGIN_GIT_REF) {
    return parsed.RELAY_CHANNEL_PLUGIN_GIT_REF.trim();
  }
  if (parsed.APP_GIT_REF) {
    return parsed.APP_GIT_REF.trim();
  }
  const runtimeEnv = `${env.NODE_ENV ?? ""}`.trim().toLowerCase();
  if (runtimeEnv === "development" || runtimeEnv === "dev") {
    return "main";
  }
  return "release";
}
