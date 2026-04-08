import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import JSON5 from "json5";
import {
  type AgentControlAction,
  agentControlResultSchema,
  type AgentControlResult,
} from "./protocol.js";

const execFile = promisify(execFileCallback);
const GATEWAY_RESTART_CHECK_ATTEMPTS = 20;
const GATEWAY_RESTART_CHECK_DELAY_MS = 500;

type GatewayLike = {
  request(method: string, params?: unknown): Promise<unknown>;
};

export class AgentControlError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentControlError";
    this.code = code;
    this.details = details;
  }
}

export async function executeAgentControl(input: {
  action: AgentControlAction;
  configPath: string;
  gateway: GatewayLike;
}): Promise<AgentControlResult> {
  const result =
    input.action.kind === "config.read"
      ? await readConfig(input.configPath)
      : input.action.kind === "config.apply"
        ? await applyConfig({
            configPath: input.configPath,
            configText: input.action.configText,
          })
        : input.action.kind === "gateway.restart"
          ? await restartGatewayService()
          : input.action.kind === "devicePairing.list"
            ? await listDevicePairing(input.gateway)
            : input.action.kind === "devicePairing.approve"
              ? await approveDevicePairing(input.gateway, input.action.requestId)
              : await setModel({
                  configPath: input.configPath,
                  model: input.action.model,
                  contextTokens: input.action.contextTokens ?? null,
                });
  return agentControlResultSchema.parse(result);
}

async function readConfig(configPath: string): Promise<AgentControlResult> {
  const { configText, config } = await readConfigFile(configPath);
  return {
    kind: "config.read",
    configText,
    config,
  };
}

async function applyConfig(input: {
  configPath: string;
  configText: string;
}): Promise<AgentControlResult> {
  const parsed = parseConfigText(input.configText);
  await atomicWriteUtf8(input.configPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return {
    kind: "config.apply",
    applied: true,
  };
}

async function listDevicePairing(gateway: GatewayLike): Promise<AgentControlResult> {
  const payload = await gateway.request("device.pair.list", {});
  const pending = readUnknownArray((payload as { pending?: unknown })?.pending);
  const paired = readUnknownArray((payload as { paired?: unknown })?.paired);
  return {
    kind: "devicePairing.list",
    pending,
    paired,
  };
}

async function approveDevicePairing(gateway: GatewayLike, requestId: string): Promise<AgentControlResult> {
  const payload = await gateway.request("device.pair.approve", { requestId });
  return {
    kind: "devicePairing.approve",
    approved: true,
    payload,
  };
}

async function setModel(input: {
  configPath: string;
  model: string;
  contextTokens: number | null;
}): Promise<AgentControlResult> {
  const { config } = await readConfigFile(input.configPath);
  const nextConfig = structuredClone(config);
  const agentsCfg = ensureRecord(nextConfig, "agents");
  const defaultsCfg = ensureRecord(agentsCfg, "defaults");
  const modelCfg = ensureRecord(defaultsCfg, "model");
  modelCfg.primary = input.model;
  if (typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens) && input.contextTokens > 0) {
    defaultsCfg.contextTokens = Math.floor(input.contextTokens);
  }
  await atomicWriteUtf8(input.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const restart = await restartGatewayService();
  return {
    kind: "model.set",
    applied: true,
    restarted: true,
    model: input.model,
    contextTokens: input.contextTokens,
    activeState: restart.activeState,
    subState: restart.subState,
    result: restart.result,
  };
}

async function restartGatewayService(): Promise<Extract<AgentControlResult, { kind: "gateway.restart" }>> {
  await execSystemctl(["--user", "restart", "openclaw-gateway.service"]);
  for (let attempt = 0; attempt < GATEWAY_RESTART_CHECK_ATTEMPTS; attempt += 1) {
    const state = await readGatewayState();
    if (state.activeState === "active" && state.subState === "running") {
      return {
        kind: "gateway.restart",
        restarted: true,
        activeState: state.activeState,
        subState: state.subState,
        result: state.result,
      };
    }
    await sleep(GATEWAY_RESTART_CHECK_DELAY_MS);
  }
  const state = await readGatewayState();
  throw new AgentControlError("GATEWAY_RESTART_FAILED", "OpenClaw gateway did not become healthy after restart", state);
}

async function readGatewayState(): Promise<{ activeState: string; subState: string; result: string | null }> {
  const [activeState, subState, result] = await Promise.all([
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "ActiveState", "--value"]),
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "SubState", "--value"]),
    execSystemctl(["--user", "show", "openclaw-gateway.service", "-p", "Result", "--value"]),
  ]);
  return {
    activeState: activeState.trim() || "unknown",
    subState: subState.trim() || "unknown",
    result: result.trim() || null,
  };
}

async function execSystemctl(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("systemctl", args, {
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root",
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "/run/user/0",
      },
    });
    return stdout;
  } catch (error) {
    throw new AgentControlError(
      "SYSTEMCTL_FAILED",
      `systemctl ${args.join(" ")} failed`,
      {
        args,
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
}

async function readConfigFile(configPath: string): Promise<{ configText: string; config: Record<string, unknown> }> {
  let configText = "";
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch (error) {
    throw new AgentControlError(
      "CONFIG_READ_FAILED",
      `Failed to read OpenClaw config at ${configPath}`,
      {
        configPath,
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
  return {
    configText,
    config: parseConfigText(configText),
  };
}

function parseConfigText(configText: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON5.parse(configText);
  } catch (error) {
    throw new AgentControlError(
      "CONFIG_PARSE_FAILED",
      "Failed to parse OpenClaw config JSON",
      {
        message: error instanceof Error ? error.message : String(error),
      },
      { cause: error }
    );
  }
  if (!isRecord(parsed)) {
    throw new AgentControlError("CONFIG_PARSE_FAILED", "OpenClaw config root must be an object");
  }
  return parsed;
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.gwtmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
