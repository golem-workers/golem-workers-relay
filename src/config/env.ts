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
  RELAY_MAX_TASKS: z.coerce.number().int().min(1).max(20).optional(),
  RELAY_WAIT_SECONDS: z.coerce.number().int().min(0).max(30).optional(),
  RELAY_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30 * 60_000).optional(),
  RELAY_CONCURRENCY: z.coerce.number().int().min(1).max(20).optional(),

  OPENCLAW_GATEWAY_WS_URL: z.string().url().optional(),
  OPENCLAW_CONFIG_PATH: z.string().min(1).optional(),
  OPENCLAW_STATE_DIR: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_GATEWAY_PASSWORD: z.string().min(1).optional(),
  OPENCLAW_SCOPES: z.string().optional(),
});

export type RelayEnv = z.infer<typeof envSchema>;

export type RelayConfig = {
  relayToken: string;
  backendBaseUrl: string;
  relayInstanceId: string;
  maxTasks: number;
  waitSeconds: number;
  taskTimeoutMs: number;
  concurrency: number;
  openclaw: {
    gatewayWsUrl?: string;
    configPath?: string;
    stateDir?: string;
    token?: string;
    password?: string;
    scopes: string[];
  };
};

export function loadRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const parsed = envSchema.parse(env) satisfies RelayEnv;
  const relayInstanceId =
    parsed.RELAY_INSTANCE_ID ||
    `${os.hostname()}-${process.pid}-${Math.random().toString(16).slice(2)}`;

  return {
    relayToken: parsed.RELAY_TOKEN,
    backendBaseUrl: parsed.BACKEND_BASE_URL.replace(/\/+$/, ""),
    relayInstanceId,
    maxTasks: parsed.RELAY_MAX_TASKS ?? 5,
    waitSeconds: parsed.RELAY_WAIT_SECONDS ?? 25,
    taskTimeoutMs: parsed.RELAY_TASK_TIMEOUT_MS ?? 120_000,
    concurrency: parsed.RELAY_CONCURRENCY ?? 1,
    openclaw: {
      gatewayWsUrl: parsed.OPENCLAW_GATEWAY_WS_URL,
      configPath: parsed.OPENCLAW_CONFIG_PATH,
      stateDir: parsed.OPENCLAW_STATE_DIR,
      token: parsed.OPENCLAW_GATEWAY_TOKEN,
      password: parsed.OPENCLAW_GATEWAY_PASSWORD,
      scopes: parseCsv(parsed.OPENCLAW_SCOPES) ?? ["operator.admin"],
    },
  };
}

// Back-compat helper for non-env sources (tests/mocks).
export function buildRelayConfigForTest(overrides: Partial<RelayConfig>): RelayConfig {
  const base: RelayConfig = {
    relayToken: "test",
    backendBaseUrl: "http://localhost:3000",
    relayInstanceId: "test-relay",
    maxTasks: 1,
    waitSeconds: 0,
    taskTimeoutMs: 5000,
    concurrency: 1,
    openclaw: { scopes: ["operator.admin"] },
  };
  return {
    ...base,
    ...overrides,
    openclaw: { ...base.openclaw, ...(overrides.openclaw ?? {}) },
  };
}

