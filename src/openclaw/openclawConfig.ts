import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

export type ResolvedGatewayAuth = {
  token?: string;
  password?: string;
};

export type ResolvedOpenclawConfig = {
  configPath: string;
  gateway: {
    wsUrl: string;
    auth: ResolvedGatewayAuth;
  };
};

function resolveDefaultStateDir(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".openclaw");
}

function resolveDefaultConfigPath(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveDefaultStateDir(env), "openclaw.json");
}

function safeReadJson5(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    // JSON5.parse returns `any`; validate shape at runtime.
    const parsed: unknown = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getNested(obj: Record<string, unknown> | null, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function resolveOpenclawConfig(env: NodeJS.ProcessEnv, input?: { gatewayWsUrl?: string }) {
  const configPath = resolveDefaultConfigPath(env);
  const parsed = safeReadJson5(configPath);

  const portFromConfig = getNested(parsed, ["gateway", "port"]);
  const port =
    typeof portFromConfig === "number" && Number.isFinite(portFromConfig)
      ? portFromConfig
      : 18789;

  const wsUrl =
    input?.gatewayWsUrl ||
    env.OPENCLAW_GATEWAY_WS_URL?.trim() ||
    `ws://127.0.0.1:${port}`;

  const tokenFromConfig = getNested(parsed, ["gateway", "auth", "token"]);
  const passwordFromConfig = getNested(parsed, ["gateway", "auth", "password"]);

  const token =
    (typeof tokenFromConfig === "string" && tokenFromConfig.trim()) ||
    env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    undefined;

  const password =
    (typeof passwordFromConfig === "string" && passwordFromConfig.trim()) ||
    env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    undefined;

  const resolved: ResolvedOpenclawConfig = {
    configPath,
    gateway: {
      wsUrl,
      auth: { token, password },
    },
  };

  return resolved;
}

