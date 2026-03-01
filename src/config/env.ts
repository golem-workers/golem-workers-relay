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

const envSchema = z.object({
  RELAY_TOKEN: z.string().min(1),
  BACKEND_BASE_URL: z.string().url(),

  RELAY_INSTANCE_ID: z.string().min(1).optional(),
  RELAY_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(2_147_483_647).optional(),
  RELAY_CONCURRENCY: z.coerce.number().int().min(1).max(20).optional(),
  RELAY_PUSH_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RELAY_PUSH_PATH: z.string().min(1).optional(),
  RELAY_PUSH_RATE_LIMIT_PER_SEC: z.coerce.number().int().min(1).max(100_000).optional(),
  RELAY_PUSH_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(10_000).optional(),
  RELAY_PUSH_MAX_QUEUE: z.coerce.number().int().min(1).max(1_000_000).optional(),

  MESSAGE_FLOW_LOG: z.coerce.boolean().optional(),

  OPENCLAW_GATEWAY_WS_URL: z.string().url().optional(),
  OPENCLAW_CONFIG_PATH: z.string().min(1).optional(),
  OPENCLAW_STATE_DIR: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_PASSWORD: z.string().min(1).optional(),
  OPENCLAW_SCOPES: z.string().optional(),

  STT_PROVIDER: z.enum(["deepgram", "openai"]).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_STT_MODEL: z.string().min(1).optional(),
  OPENAI_STT_LANGUAGE: z.string().min(1).optional(),
  STT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).optional(),
});

export type RelayEnv = z.infer<typeof envSchema>;

export type RelayConfig = {
  relayToken: string;
  backendBaseUrl: string;
  relayInstanceId: string;
  taskTimeoutMs: number;
  concurrency: number;
  pushPort: number;
  pushPath: string;
  pushRateLimitPerSecond: number;
  pushMaxConcurrentRequests: number;
  pushMaxQueue: number;
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
  };
  stt: {
    provider: "deepgram" | "openai";
    deepgramApiKey?: string;
    openaiApiKey?: string;
    openaiModel: string;
    openaiLanguage?: string;
    timeoutMs: number;
  };
};

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = envSchema.parse(env) satisfies RelayEnv;
  const devLogEnabled = parsed.MESSAGE_FLOW_LOG ?? false;
  const devLogTextMaxLen = 200;
  const devLogGatewayFrames = false;

  const relayInstanceId =
    parsed.RELAY_INSTANCE_ID ||
    `${os.hostname()}-${process.pid}-${Math.random().toString(16).slice(2)}`;

  return {
    relayToken: parsed.RELAY_TOKEN,
    backendBaseUrl: parsed.BACKEND_BASE_URL.replace(/\/+$/, ""),
    relayInstanceId,
    taskTimeoutMs: parsed.RELAY_TASK_TIMEOUT_MS ?? 9_999_999,
    concurrency: parsed.RELAY_CONCURRENCY ?? 1,
    pushPort: parsed.RELAY_PUSH_PORT ?? 18790,
    pushPath: parsed.RELAY_PUSH_PATH ?? "/relay/messages",
    pushRateLimitPerSecond: parsed.RELAY_PUSH_RATE_LIMIT_PER_SEC ?? 100,
    pushMaxConcurrentRequests: parsed.RELAY_PUSH_MAX_CONCURRENT_REQUESTS ?? 100,
    pushMaxQueue: parsed.RELAY_PUSH_MAX_QUEUE ?? 2000,
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
    },
    stt: {
      provider: parsed.STT_PROVIDER ?? "deepgram",
      deepgramApiKey: parsed.DEEPGRAM_API_KEY,
      openaiApiKey: parsed.OPENAI_API_KEY,
      openaiModel: parsed.OPENAI_STT_MODEL ?? "whisper-1",
      openaiLanguage: parsed.OPENAI_STT_LANGUAGE,
      timeoutMs: parsed.STT_TIMEOUT_MS ?? 15_000,
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
    concurrency: 1,
    pushPort: 18790,
    pushPath: "/relay/messages",
    pushRateLimitPerSecond: 100,
    pushMaxConcurrentRequests: 100,
    pushMaxQueue: 2000,
    devLogEnabled: false,
    devLogTextMaxLen: 200,
    devLogGatewayFrames: false,
    openclaw: { scopes: ["operator.admin"] },
    stt: {
      provider: "deepgram",
      openaiModel: "whisper-1",
      timeoutMs: 15_000,
    },
  };
  return {
    ...base,
    ...overrides,
    openclaw: { ...base.openclaw, ...(overrides.openclaw ?? {}) },
  };
}

