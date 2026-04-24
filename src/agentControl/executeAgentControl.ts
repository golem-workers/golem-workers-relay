import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import JSON5 from "json5";
import {
  type AgentControlAction,
  agentControlResultSchema,
  type AgentControlResult,
} from "./protocol.js";

const execFile = promisify(execFileCallback);
const GATEWAY_RESTART_CHECK_ATTEMPTS = 20;
const GATEWAY_RESTART_CHECK_DELAY_MS = 500;
const FILE_LOCK_RETRY_ATTEMPTS = 50;
const FILE_LOCK_RETRY_DELAY_MS = 100;
const VALID_THINKING_DEFAULTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"]);

type GatewayLike = {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
};

type ModelSetThinkingDefault = Extract<AgentControlAction, { kind: "model.set" }>["thinkingDefault"];
type ModelSetFallbacks = Extract<AgentControlAction, { kind: "model.set" }>["fallbacks"];

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

function readThinkingDefault(value: unknown): ModelSetThinkingDefault {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return VALID_THINKING_DEFAULTS.has(normalized) ? (normalized as NonNullable<ModelSetThinkingDefault>) : null;
}

export async function executeAgentControl(input: {
  action: AgentControlAction;
  configPath: string;
  gateway: GatewayLike;
}): Promise<AgentControlResult> {
  const result =
    input.action.kind === "config.read"
      ? await readConfig(input.configPath)
      : input.action.kind === "channels.status"
        ? await readChannelsStatus()
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
            : input.action.kind === "channelPairing.list"
              ? await listChannelPairing(input.action.channel, input.action.accountId)
              : input.action.kind === "channelPairing.approve"
                ? await approveChannelPairing(input.action.channel, input.action.code, input.action.accountId)
              : input.action.kind === "whatsapp.login.start"
                ? await startWhatsAppLogin(input.gateway, input.action)
              : input.action.kind === "whatsapp.login.wait"
                ? await waitForWhatsAppLogin(input.gateway, input.action)
              : await setModel({
                  configPath: input.configPath,
                  model: input.action.model,
                  fallbacks: input.action.fallbacks,
                  contextTokens: input.action.contextTokens ?? null,
                  thinkingDefault: input.action.thinkingDefault,
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

async function readChannelsStatus(): Promise<AgentControlResult> {
  let stdout = "";
  let stderr = "";
  try {
    const result = await execFile("openclaw", ["channels", "status", "--json"], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const details =
      error && typeof error === "object"
        ? {
            stdout: typeof (error as { stdout?: unknown }).stdout === "string"
              ? (error as { stdout?: string }).stdout
              : "",
            stderr: typeof (error as { stderr?: unknown }).stderr === "string"
              ? (error as { stderr?: string }).stderr
              : "",
            code: typeof (error as { code?: unknown }).code === "string"
              ? (error as { code?: string }).code
              : null,
          }
        : { stdout: "", stderr: "", code: null };
    throw new AgentControlError(
      "CHANNELS_STATUS_FAILED",
      "Failed to read OpenClaw channel runtime status.",
      details,
      { cause: error }
    );
  }
  return {
    kind: "channels.status",
    snapshot: parseJsonObjectFromCommandOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`, "channels.status"),
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

async function startWhatsAppLogin(
  gateway: GatewayLike,
  input: Extract<AgentControlAction, { kind: "whatsapp.login.start" }>
): Promise<AgentControlResult> {
  const requestTimeoutMs = Math.max((input.timeoutMs ?? 120_000) + 5_000, 30_000);
  const payload = await gateway.request("web.login.start", {
    force: input.forceRelink === true,
    timeoutMs: input.timeoutMs,
  }, {
    timeoutMs: requestTimeoutMs,
  }) as { qrDataUrl?: unknown; message?: unknown };
  const qrDataUrl =
    typeof payload?.qrDataUrl === "string" && payload.qrDataUrl.trim().length > 0
      ? payload.qrDataUrl
      : null;
  const message =
    typeof payload?.message === "string" && payload.message.trim().length > 0
      ? payload.message
      : (qrDataUrl ? "Scan the QR in WhatsApp → Linked Devices." : "WhatsApp login started.");
  return {
    kind: "whatsapp.login.start",
    qrDataUrl,
    message,
  };
}

async function waitForWhatsAppLogin(
  gateway: GatewayLike,
  input: Extract<AgentControlAction, { kind: "whatsapp.login.wait" }>
): Promise<AgentControlResult> {
  const payload = await gateway.request("web.login.wait", {
    timeoutMs: input.timeoutMs,
  }) as { connected?: unknown; message?: unknown };
  return {
    kind: "whatsapp.login.wait",
    connected: payload?.connected === true,
    message:
      typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : "WhatsApp login status updated.",
  };
}

type ChannelPairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt?: string;
  meta?: Record<string, unknown>;
};

const CHANNEL_PAIRING_TTL_MS = 3_600_000;

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectFromCommandOutput(raw: string, context: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index]?.trimStart() ?? "";
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(lines.slice(index).join("\n"));
      if (isRecord(parsed)) {
        return parsed;
      }
      break;
    } catch {
      // Keep scanning until we hit the actual JSON payload.
    }
  }
  throw new AgentControlError("CHANNELS_STATUS_BAD_RESPONSE", `OpenClaw ${context} output was not valid JSON.`, {
    output: raw,
  });
}

function normalizeLowercaseString(value: unknown): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

function safeChannelKey(channel: string): string {
  const safe = normalizeLowercaseString(channel).replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_CHANNEL", "Invalid pairing channel", { channel });
  }
  return safe;
}

function safeAccountKey(accountId: string): string {
  const safe = normalizeLowercaseString(accountId).replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_ACCOUNT", "Invalid pairing account id", { accountId });
  }
  return safe;
}

function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  if (explicit) return explicit;
  return path.join(env.HOME || os.homedir() || "/root", ".openclaw");
}

function resolveOpenclawCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenclawStateDir(env), "credentials");
}

function resolveChannelPairingPath(channel: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenclawCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}

function resolveChannelAllowFromPath(channel: string, accountId?: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = normalizeOptionalString(accountId);
  if (!normalizedAccountId) {
    return path.join(resolveOpenclawCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(resolveOpenclawCredentialsDir(env), `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`);
}

function parseIsoTimestamp(value: unknown): number | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isExpiredPairingRequest(entry: ChannelPairingRequest, nowMs: number): boolean {
  const createdAtMs = parseIsoTimestamp(entry.createdAt);
  if (createdAtMs === null) return true;
  return nowMs - createdAtMs > CHANNEL_PAIRING_TTL_MS;
}

function normalizeChannelPairingRequest(value: unknown): ChannelPairingRequest | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const code = normalizeOptionalString(value.code)?.toUpperCase() ?? null;
  const createdAt = normalizeOptionalString(value.createdAt);
  const lastSeenAt = normalizeOptionalString(value.lastSeenAt) ?? undefined;
  const meta = isRecord(value.meta) ? value.meta : undefined;
  if (!id || !code || !createdAt) return null;
  return {
    id,
    code,
    createdAt,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(meta ? { meta } : {}),
  };
}

async function readJsonFileWithFallback<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.gwtmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw error;
    }
    await writeJsonFileAtomic(filePath, fallback);
  }
}

async function withFileLock<T>(filePath: string, fallback: unknown, fn: () => Promise<T>): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  const lockPath = `${filePath}.gwlock`;
  for (let attempt = 0; attempt < FILE_LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        throw error;
      }
      await sleep(FILE_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new AgentControlError("CHANNEL_PAIRING_LOCK_TIMEOUT", "Timed out waiting for pairing store lock", {
    filePath,
  });
}

async function readChannelPairingRequests(channel: string, accountId?: string): Promise<ChannelPairingRequest[]> {
  const filePath = resolveChannelPairingPath(channel);
  return withFileLock(filePath, { version: 1, requests: [] }, async () => {
    const payload = await readJsonFileWithFallback<{ requests?: unknown[] }>(filePath, { requests: [] });
    const nowMs = Date.now();
    const normalizedAccountId = normalizeOptionalString(accountId);
    const requests = Array.isArray(payload.requests)
      ? payload.requests
          .map((entry) => normalizeChannelPairingRequest(entry))
          .filter((entry): entry is ChannelPairingRequest => entry !== null)
          .filter((entry) => !isExpiredPairingRequest(entry, nowMs))
          .filter((entry) => {
            if (!normalizedAccountId) return true;
            return normalizeOptionalString(entry.meta?.accountId) === normalizedAccountId;
          })
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      : [];
    return requests;
  });
}

async function readAllowFromEntries(filePath: string): Promise<string[]> {
  const payload = await readJsonFileWithFallback<{ allowFrom?: unknown[] }>(filePath, { allowFrom: [] });
  return Array.isArray(payload.allowFrom)
    ? payload.allowFrom
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => entry !== null)
    : [];
}

async function listChannelPairing(channel: string, accountId?: string): Promise<AgentControlResult> {
  return {
    kind: "channelPairing.list",
    requests: await readChannelPairingRequests(channel, accountId),
  };
}

async function approveChannelPairing(
  channel: string,
  code: string,
  accountId?: string
): Promise<AgentControlResult> {
  const normalizedCode = normalizeOptionalString(code)?.toUpperCase() ?? "";
  if (!normalizedCode) {
    throw new AgentControlError("CHANNEL_PAIRING_INVALID_CODE", "Invalid pairing code");
  }
  const filePath = resolveChannelPairingPath(channel);
  return withFileLock(filePath, { version: 1, requests: [] }, async () => {
    const payload = await readJsonFileWithFallback<{ requests?: unknown[] }>(filePath, { requests: [] });
    const requests = Array.isArray(payload.requests)
      ? payload.requests
          .map((entry) => normalizeChannelPairingRequest(entry))
          .filter((entry): entry is ChannelPairingRequest => entry !== null)
      : [];
    const normalizedAccountId = normalizeOptionalString(accountId);
    const matchIndex = requests.findIndex((entry) => {
      if (entry.code !== normalizedCode) return false;
      if (!normalizedAccountId) return true;
      return normalizeOptionalString(entry.meta?.accountId) === normalizedAccountId;
    });
    if (matchIndex < 0) {
      throw new AgentControlError("CHANNEL_PAIRING_UNKNOWN_CODE", "Unknown pairing code", {
        channel,
        code: normalizedCode,
      });
    }
    const approved = requests[matchIndex];
    if (!approved) {
      throw new AgentControlError("CHANNEL_PAIRING_UNKNOWN_CODE", "Unknown pairing code", {
        channel,
        code: normalizedCode,
      });
    }
    const nextRequests = requests.filter((_, index) => index !== matchIndex);
    await writeJsonFileAtomic(filePath, {
      version: 1,
      requests: nextRequests,
    });

    const effectiveAccountId =
      normalizeOptionalString(accountId) ?? normalizeOptionalString(approved.meta?.accountId) ?? undefined;
    const allowFromPath = resolveChannelAllowFromPath(channel, effectiveAccountId);
    await withFileLock(allowFromPath, { version: 1, allowFrom: [] }, async () => {
      const currentAllowFrom = await readAllowFromEntries(allowFromPath);
      if (!currentAllowFrom.includes(approved.id)) {
        await writeJsonFileAtomic(allowFromPath, {
          version: 1,
          allowFrom: [...currentAllowFrom, approved.id],
        });
      }
    });

    return {
      kind: "channelPairing.approve",
      approved: true,
      payload: {
        id: approved.id,
        code: approved.code,
        entry: approved,
      },
    };
  });
}

async function setModel(input: {
  configPath: string;
  model: string;
  fallbacks: ModelSetFallbacks;
  contextTokens: number | null;
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | null;
}): Promise<AgentControlResult> {
  const { config } = await readConfigFile(input.configPath);
  const nextConfig = structuredClone(config);
  const agentsCfg = ensureRecord(nextConfig, "agents");
  const defaultsCfg = ensureRecord(agentsCfg, "defaults");
  const modelCfg = ensureRecord(defaultsCfg, "model");
  const fallbacks = input.fallbacks
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  modelCfg.primary = input.model;
  modelCfg.fallbacks = fallbacks;
  const modelsCfg = ensureRecord(defaultsCfg, "models");
  const existingPrimaryModel = modelsCfg[input.model];
  modelsCfg[input.model] = isRecord(existingPrimaryModel) ? existingPrimaryModel : {};
  for (const fallbackModel of fallbacks) {
    const existingFallbackModel = modelsCfg[fallbackModel];
    modelsCfg[fallbackModel] = isRecord(existingFallbackModel) ? existingFallbackModel : {};
  }
  if (typeof input.contextTokens === "number" && Number.isFinite(input.contextTokens) && input.contextTokens > 0) {
    defaultsCfg.contextTokens = Math.floor(input.contextTokens);
  }
  if (typeof input.thinkingDefault === "string" && input.thinkingDefault.trim()) {
    defaultsCfg.thinkingDefault = input.thinkingDefault;
  } else if (input.thinkingDefault === null) {
    delete defaultsCfg.thinkingDefault;
  }
  await atomicWriteUtf8(input.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const restart = await restartGatewayService();
  return {
    kind: "model.set",
    applied: true,
    restarted: true,
    model: input.model,
    fallbacks,
    contextTokens: input.contextTokens,
    thinkingDefault: readThinkingDefault(defaultsCfg.thinkingDefault),
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

function readUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
