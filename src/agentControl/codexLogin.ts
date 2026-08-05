import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import JSON5 from "json5";
import type { CodexAuthBundle } from "./protocol.js";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const AUTH_PROFILES_FILE = "auth-profiles.json";
const CODEX_AUTH_SYNC_STATE_FILE = "golem-auth-sync.json";
const MAIN_AGENT_ID = "main";

type CodexLoginState = "not_logged_in" | "pending" | "connected" | "failed" | "unavailable";
type CodexAuthMode = "openai_login" | "api_key";

type CodexAuthModeStatus = {
  available: boolean;
  active: boolean;
  message: string;
};

type CodexAuthModes = {
  openaiLogin: CodexAuthModeStatus;
  apiKey: CodexAuthModeStatus;
};

export type CodexLoginActionResult = {
  kind: "codex.login.start" | "codex.login.status";
  state: CodexLoginState;
  message: string;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAtMs: number | null;
  pollAfterMs: number | null;
  profileId: string | null;
  email: string | null;
  accountId: string | null;
  lastError: string | null;
  authModes: CodexAuthModes;
};

export type CodexAuthSetActionResult = {
  kind: "codex.auth.set";
  mode: CodexAuthMode;
  applied: true;
  authModes: CodexAuthModes;
};

export type CodexAuthExportActionResult = {
  kind: "codex.auth.export";
  bundle: CodexAuthBundle;
};

export type CodexAuthImportActionResult = {
  kind: "codex.auth.import";
  applied: true;
  profileId: string;
  email: string | null;
  accountId: string | null;
  expiresAtMs: number;
  authModes: CodexAuthModes;
};

export type CodexAuthSyncActionResult = {
  kind: "codex.auth.sync";
  applied: boolean;
  reason: "applied" | "up_to_date";
  bundleVersion: number;
  profileId: string;
  email: string | null;
  accountId: string | null;
  expiresAtMs: number;
  authModes: CodexAuthModes;
};

export type CodexAuthClearActionResult = {
  kind: "codex.auth.clear";
  applied: true;
};

type CodexJwtPayload = {
  exp?: unknown;
  iss?: unknown;
  sub?: unknown;
  "https://api.openai.com/profile"?: {
    email?: unknown;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: unknown;
    chatgpt_account_user_id?: unknown;
    chatgpt_plan_type?: unknown;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
  };
};

type OAuthCredential = {
  type: "oauth";
  provider: "openai" | "openai-codex";
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
};

type AuthProfilesStore = {
  version: number;
  profiles: Record<string, OAuthCredential | Record<string, unknown>>;
};

type AuthProfileStateStore = {
  version: number;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
};

type PendingCodexLogin = {
  state: "pending" | "connected" | "failed";
  message: string;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAtMs: number | null;
  pollAfterMs: number | null;
  profileId: string | null;
  email: string | null;
  accountId: string | null;
  lastError: string | null;
  ready: Promise<void>;
  resolveReady: () => void;
};

type CodexCliAuthJson = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: unknown;
  last_refresh?: unknown;
};

type CodexCliChatGptTokens = {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
};

type RequestedDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
};

type DeviceCodeAuthorizationCode = {
  authorizationCode: string;
  codeVerifier: string;
};

type DeviceCodeCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

type CodexAuthSyncState = {
  formatVersion: 1;
  bundleVersion: number;
  profileId: string;
  expiresAtMs: number;
  syncedAt: string;
};

type FileSnapshot = {
  filePath: string;
  contents: Buffer | null;
};

type CodexRuntimeAuthRow = {
  json: string;
  updatedAt: number;
};

type CodexRuntimeAuthSnapshot = {
  databaseExisted: boolean;
  storeTableExisted: boolean;
  stateTableExisted: boolean;
  storeRow: CodexRuntimeAuthRow | null;
  stateRow: CodexRuntimeAuthRow | null;
};

let pendingCodexLogin: PendingCodexLogin | null = null;

export const __testing = {
  resetCodexLoginState(): void {
    pendingCodexLogin = null;
  },
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFutureEpochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeDeviceCodeErrorText(value: string): string {
  const esc = String.fromCharCode(0x1b);
  const ansiCsiRegex = new RegExp(`${esc}\\[[\\u0020-\\u003f]*[\\u0040-\\u007e]`, "g");
  const osc8Regex = new RegExp(`${esc}\\]8;;.*?${esc}\\\\|${esc}\\]8;;${esc}\\\\`, "g");
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g");
  return value.replace(osc8Regex, "").replace(ansiCsiRegex, "").replace(controlCharsRegex, " ").replace(/\s+/g, " ").trim();
}

function formatDeviceCodeError(params: { prefix: string; status: number; bodyText: string }): string {
  const body = parseJsonObject(params.bodyText);
  const error = normalizeString(body?.error);
  const description = normalizeString(body?.error_description);
  const safeError = error ? sanitizeDeviceCodeErrorText(error) : undefined;
  const safeDescription = description ? sanitizeDeviceCodeErrorText(description) : undefined;
  if (safeError && safeDescription) {
    return `${params.prefix}: ${safeError} (${safeDescription})`;
  }
  if (safeError) {
    return `${params.prefix}: ${safeError}`;
  }
  const safeBody = sanitizeDeviceCodeErrorText(params.bodyText);
  return safeBody ? `${params.prefix}: HTTP ${params.status} ${safeBody}` : `${params.prefix}: HTTP ${params.status}`;
}

function resolveHeaders(contentType: string): Record<string, string> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  return {
    "Content-Type": contentType,
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

function resolveNextPollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

function decodeCodexJwtPayload(accessToken: string): CodexJwtPayload | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as CodexJwtPayload) : null;
  } catch {
    return null;
  }
}

function resolveCodexStableSubject(payload: CodexJwtPayload | null): string | undefined {
  const auth = payload?.["https://api.openai.com/auth"];
  const accountUserId = normalizeString(auth?.chatgpt_account_user_id);
  if (accountUserId) {
    return accountUserId;
  }
  const userId = normalizeString(auth?.chatgpt_user_id) ?? normalizeString(auth?.user_id);
  if (userId) {
    return userId;
  }
  const iss = normalizeString(payload?.iss);
  const sub = normalizeString(payload?.sub);
  if (iss && sub) {
    return `${iss}|${sub}`;
  }
  return sub ?? undefined;
}

function resolveCodexAuthIdentity(accessToken: string): {
  email?: string;
  accountId?: string;
  chatgptPlanType?: string;
  profileName?: string;
} {
  const payload = decodeCodexJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"];
  const accountId = normalizeString(auth?.chatgpt_account_id) ?? undefined;
  const chatgptPlanType = normalizeString(auth?.chatgpt_plan_type) ?? undefined;
  const email = normalizeString(payload?.["https://api.openai.com/profile"]?.email) ?? undefined;
  if (email) {
    return { email, accountId, chatgptPlanType, profileName: email };
  }
  const stableSubject = resolveCodexStableSubject(payload);
  return {
    accountId,
    chatgptPlanType,
    ...(stableSubject
      ? {
          profileName: `id-${Buffer.from(stableSubject).toString("base64url")}`,
        }
      : {}),
  };
}

function buildAuthProfileId(providerId: string, profileName?: string | null): string {
  const normalizedName = normalizeString(profileName) ?? "default";
  return `${providerId}:${normalizedName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfigObject(configPath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed: unknown = JSON5.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${configPath} did not parse to an object.`);
  }
  return parsed;
}

async function readAuthProfilesStore(authStorePath: string): Promise<AuthProfilesStore> {
  try {
    const raw = await fs.readFile(authStorePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && isRecord(parsed.profiles) && typeof parsed.version === "number") {
      return {
        version: parsed.version,
        profiles: parsed.profiles as AuthProfilesStore["profiles"],
      };
    }
  } catch {
    // Fall through to a new store.
  }
  return {
    version: 1,
    profiles: {},
  };
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

function resolveCodexAuthStorePaths(configPath: string): string[] {
  const stateDir = path.dirname(configPath);
  return [path.join(stateDir, AUTH_PROFILES_FILE), path.join(stateDir, "agents", MAIN_AGENT_ID, "agent", AUTH_PROFILES_FILE)];
}

function resolveCodexCliAuthPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
}

function resolveCodexAuthSyncStatePath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), CODEX_AUTH_SYNC_STATE_FILE);
}

async function readCodexCliAuthJson(): Promise<CodexCliAuthJson> {
  try {
    const raw = await fs.readFile(resolveCodexCliAuthPath(), "utf8");
    const parsed: unknown = JSON5.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeCodexCliAuthJson(auth: CodexCliAuthJson): Promise<void> {
  await writeJsonFile(resolveCodexCliAuthPath(), auth);
}

async function resolveCodexAuthModes(params: { loginAvailable: boolean; loginMessage: string }): Promise<CodexAuthModes> {
  const authJson = await readCodexCliAuthJson();
  const authMode = normalizeString(authJson.auth_mode)?.toLowerCase() ?? null;
  const apiKeyAvailable = Boolean(normalizeString(authJson.OPENAI_API_KEY) || normalizeString(process.env.OPENAI_API_KEY));
  return {
    openaiLogin: {
      available: params.loginAvailable,
      active: params.loginAvailable && authMode === "chatgpt",
      message: params.loginMessage,
    },
    apiKey: {
      available: apiKeyAvailable,
      active: apiKeyAvailable && authMode === "apikey",
      message: apiKeyAvailable ? "Codex API access is available on this agent." : "Codex API access is not configured on this agent.",
    },
  };
}

function coerceAuthProfileStateStore(value: unknown): AuthProfileStateStore {
  if (!isRecord(value)) {
    return { version: 1 };
  }
  const order = isRecord(value.order)
    ? Object.fromEntries(
        Object.entries(value.order).flatMap(([provider, profileIds]) => {
          if (!Array.isArray(profileIds)) {
            return [];
          }
          const normalized = profileIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
          return normalized.length > 0 ? [[provider, normalized]] : [];
        }),
      )
    : undefined;
  const lastGood = isRecord(value.lastGood)
    ? Object.fromEntries(
        Object.entries(value.lastGood).flatMap(([provider, profileId]) =>
          typeof profileId === "string" && profileId.trim().length > 0 ? [[provider, profileId]] : [],
        ),
      )
    : undefined;
  return {
    version: typeof value.version === "number" ? value.version : 1,
    ...(order && Object.keys(order).length > 0 ? { order } : {}),
    ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : {}),
  };
}

function parseSqliteJsonCell(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function resolveCodexAgentDir(configPath: string): string {
  return path.join(path.dirname(configPath), "agents", MAIN_AGENT_ID, "agent");
}

function resolveCodexAuthProfileDatabasePath(configPath: string): string {
  return path.join(resolveCodexAgentDir(configPath), "openclaw-agent.sqlite");
}

function resolveCodexSessionsStorePath(configPath: string): string {
  return path.join(path.dirname(configPath), "agents", MAIN_AGENT_ID, "sessions", "sessions.json");
}

function replaceOpenAiProfiles(
  profiles: AuthProfilesStore["profiles"],
  profileId: string,
  credential: OAuthCredential,
): AuthProfilesStore["profiles"] {
  return {
    [profileId]: credential,
    ...Object.fromEntries(
      Object.entries(profiles).filter(([, value]) => !isOpenAiCredential(value)),
    ),
  };
}

async function retargetCodexSessionAuthProfiles(
  configPath: string,
  profileId: string,
): Promise<void> {
  const sessionsPath = resolveCodexSessionsStorePath(configPath);
  let sessions: unknown;
  try {
    sessions = JSON.parse(await fs.readFile(sessionsPath, "utf8")) as unknown;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!isRecord(sessions)) {
    return;
  }
  let changed = false;
  for (const entry of Object.values(sessions)) {
    if (
      !isRecord(entry) ||
      typeof entry.authProfileOverride !== "string" ||
      !entry.authProfileOverride.startsWith("openai:") ||
      entry.authProfileOverride === profileId
    ) {
      continue;
    }
    entry.authProfileOverride = profileId;
    entry.authProfileOverrideSource = "auto";
    entry.authProfileOverrideCompactionCount =
      typeof entry.compactionCount === "number" ? entry.compactionCount : 0;
    changed = true;
  }
  if (changed) {
    await writeJsonFile(sessionsPath, sessions);
  }
}

async function updateCodexRuntimeAuthStore(input: { configPath: string; profileId: string; credential: OAuthCredential }): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = resolveCodexAuthProfileDatabasePath(input.configPath);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rawStore = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json?: string } | undefined;
      const store = readAuthProfilesStoreFromRaw(parseSqliteJsonCell(rawStore?.store_json));
      store.profiles = replaceOpenAiProfiles(store.profiles, input.profileId, input.credential);

      const rawState = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary") as { state_json?: string } | undefined;
      const state = coerceAuthProfileStateStore(parseSqliteJsonCell(rawState?.state_json));
      state.order = {
        ...state.order,
        openai: [input.profileId],
      };
      state.lastGood = {
        ...state.lastGood,
        openai: input.profileId,
      };

      db.prepare(
        `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at`,
      ).run("primary", JSON.stringify(store), now);
      db.prepare(
        `INSERT INTO auth_profile_state (state_key, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      ).run("primary", JSON.stringify(state), now);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function readAuthProfilesStoreFromRaw(value: unknown): AuthProfilesStore {
  if (isRecord(value) && isRecord(value.profiles) && typeof value.version === "number") {
    return {
      version: value.version,
      profiles: value.profiles as AuthProfilesStore["profiles"],
    };
  }
  return {
    version: 1,
    profiles: {},
  };
}

async function readRuntimeAuthProfilesStore(configPath: string): Promise<AuthProfilesStore> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const databasePath = resolveCodexAuthProfileDatabasePath(configPath);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const rawStore = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json?: string } | undefined;
      return readAuthProfilesStoreFromRaw(parseSqliteJsonCell(rawStore?.store_json));
    } finally {
      db.close();
    }
  } catch {
    return {
      version: 1,
      profiles: {},
    };
  }
}

function buildOAuthCredential(input: { creds: DeviceCodeCredentials; identity: ReturnType<typeof resolveCodexAuthIdentity> }): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: input.creds.access,
    refresh: input.creds.refresh,
    expires: input.creds.expires,
    ...(input.identity.email ? { email: input.identity.email } : {}),
    ...(input.identity.accountId ? { accountId: input.identity.accountId } : {}),
    ...(input.identity.chatgptPlanType ? { chatgptPlanType: input.identity.chatgptPlanType } : {}),
  };
}

async function persistCodexCredentials(input: {
  configPath: string;
  creds: DeviceCodeCredentials;
  identityToken?: string;
  profileId?: string;
}): Promise<{
  profileId: string;
  email: string | null;
  accountId: string | null;
  tokens: CodexCliChatGptTokens;
}> {
  const identity = resolveCodexAuthIdentity(input.identityToken ?? input.creds.access);
  const profileId = input.profileId ?? buildAuthProfileId("openai", identity.profileName);
  const credential = buildOAuthCredential({ creds: input.creds, identity });
  const tokens = buildCodexCliChatGptTokens(credential);
  if (!tokens) {
    throw new Error("OpenAI OAuth token exchange response was incomplete.");
  }
  for (const authStorePath of resolveCodexAuthStorePaths(input.configPath)) {
    const authStore = await readAuthProfilesStore(authStorePath);
    authStore.profiles = replaceOpenAiProfiles(authStore.profiles, profileId, credential);
    await writeJsonFile(authStorePath, authStore);
  }
  await updateCodexRuntimeAuthStore({
    configPath: input.configPath,
    profileId,
    credential,
  });

  const currentConfig = await readConfigObject(input.configPath);
  const currentAuth = isRecord(currentConfig.auth) ? currentConfig.auth : {};
  const currentProfiles = isRecord(currentAuth.profiles) ? currentAuth.profiles : {};
  const currentOrder = isRecord(currentAuth.order) ? currentAuth.order : {};
  const currentAgents = isRecord(currentConfig.agents) ? currentConfig.agents : {};
  const currentDefaults = isRecord(currentAgents.defaults) ? currentAgents.defaults : {};
  const currentModels = isRecord(currentDefaults.models) ? currentDefaults.models : {};
  const retainedProfiles = Object.fromEntries(
    Object.entries(currentProfiles).filter(
      ([, profile]) =>
        !(
          isRecord(profile) &&
          (profile.provider === "openai" || profile.provider === "openai-codex") &&
          profile.mode === "oauth"
        ),
    ),
  );

  const nextConfig = {
    ...currentConfig,
    auth: {
      ...currentAuth,
      profiles: {
        ...retainedProfiles,
        [profileId]: {
          provider: "openai",
          mode: "oauth",
          ...(identity.email ? { email: identity.email } : {}),
        },
      },
      order: {
        ...currentOrder,
        openai: [profileId],
      },
    },
    agents: {
      ...currentAgents,
      defaults: {
        ...currentDefaults,
        models: {
          ...currentModels,
          [OPENAI_CODEX_DEFAULT_MODEL]: {
            ...(isRecord(currentModels[OPENAI_CODEX_DEFAULT_MODEL]) ? currentModels[OPENAI_CODEX_DEFAULT_MODEL] : {}),
            agentRuntime: { id: "codex" },
          },
        },
      },
    },
  };
  await writeJsonFile(input.configPath, nextConfig);
  await retargetCodexSessionAuthProfiles(input.configPath, profileId);
  return {
    profileId,
    email: identity.email ?? null,
    accountId: identity.accountId ?? null,
    tokens,
  };
}

function buildCodexCliChatGptTokens(credential: Record<string, unknown>): CodexCliChatGptTokens | null {
  const accessToken = normalizeString(credential.access);
  const refreshToken = normalizeString(credential.refresh);
  if (!accessToken || !refreshToken) {
    return null;
  }
  const accountId = normalizeString(credential.accountId);
  return {
    id_token: accessToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(accountId ? { account_id: accountId } : {}),
  };
}

async function writeCodexCliChatGptAuth(tokens: CodexCliChatGptTokens, lastRefresh?: string | null): Promise<void> {
  const authJson = await readCodexCliAuthJson();
  const chatGptAuthJson = { ...authJson };
  delete chatGptAuthJson.OPENAI_API_KEY;
  await writeCodexCliAuthJson({
    ...chatGptAuthJson,
    auth_mode: "chatgpt",
    tokens,
    last_refresh: lastRefresh ?? new Date().toISOString(),
  });
}

async function requestDeviceCode(fetchFn: typeof fetch): Promise<RequestedDeviceCode> {
  const response = await fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: resolveHeaders("application/json"),
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("OpenAI Codex device code login is not enabled for this server.");
    }
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device code request failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const deviceAuthId = normalizeString(body?.device_auth_id);
  const userCode = normalizeString(body?.user_code) ?? normalizeString(body?.usercode);
  const intervalSeconds = normalizeFutureEpochSeconds(body?.interval);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    intervalMs: typeof intervalSeconds === "number" ? intervalSeconds * 1000 : OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

async function pollDeviceAuthorization(params: {
  fetchFn: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}): Promise<DeviceCodeAuthorizationCode> {
  const deadlineMs = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;
  while (Date.now() < deadlineMs) {
    const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: resolveHeaders("application/json"),
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
    });
    const bodyText = await response.text();
    if (response.ok) {
      const body = parseJsonObject(bodyText);
      const authorizationCode = normalizeString(body?.authorization_code);
      const codeVerifier = normalizeString(body?.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("OpenAI device authorization response was missing the exchange code.");
      }
      return { authorizationCode, codeVerifier };
    }
    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, resolveNextPollDelayMs(params.intervalMs, deadlineMs)));
      continue;
    }
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device authorization failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  throw new Error("OpenAI device authorization timed out after 15 minutes.");
}

async function exchangeDeviceAuthorization(params: { fetchFn: typeof fetch; authorizationCode: string; codeVerifier: string }): Promise<DeviceCodeCredentials> {
  const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: resolveHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device token exchange failed",
        status: response.status,
        bodyText,
      }),
    );
  }
  const body = parseJsonObject(bodyText);
  const access = normalizeString(body?.access_token);
  const refresh = normalizeString(body?.refresh_token);
  const expiresIn = normalizeFutureEpochSeconds(body?.expires_in);
  if (!access || !refresh || !expiresIn) {
    throw new Error("OpenAI OAuth token exchange response was incomplete.");
  }
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
  };
}

function buildResult(
  kind: "codex.login.start" | "codex.login.status",
  state: CodexLoginState,
  params: Partial<Omit<CodexLoginActionResult, "kind" | "state">> & {
    message: string;
    authModes: CodexAuthModes;
  },
): CodexLoginActionResult {
  return {
    kind,
    state,
    message: params.message,
    verificationUrl: params.verificationUrl ?? null,
    userCode: params.userCode ?? null,
    expiresAtMs: params.expiresAtMs ?? null,
    pollAfterMs: params.pollAfterMs ?? null,
    profileId: params.profileId ?? null,
    email: params.email ?? null,
    accountId: params.accountId ?? null,
    lastError: params.lastError ?? null,
    authModes: params.authModes,
  };
}

async function readPersistedCodexOAuthEntries(configPath: string): Promise<Array<[string, Record<string, unknown>]>> {
  const entriesByProfileId = new Map<string, Record<string, unknown>>();
  const stores = [
    await readRuntimeAuthProfilesStore(configPath),
    ...(await Promise.all(resolveCodexAuthStorePaths(configPath).map((authStorePath) => readAuthProfilesStore(authStorePath)))),
  ];
  for (const store of stores) {
    for (const [profileId, credential] of Object.entries(store.profiles)) {
      if (!isRecord(credential)) {
        continue;
      }
      if (credential.type !== "oauth" || (credential.provider !== "openai" && credential.provider !== "openai-codex")) {
        continue;
      }
      if (!entriesByProfileId.has(profileId)) {
        entriesByProfileId.set(profileId, credential);
      }
    }
  }
  return Array.from(entriesByProfileId.entries());
}

function pickLiveCodexOAuthEntry(entries: Array<[string, Record<string, unknown>]>): [string, Record<string, unknown>] | null {
  if (entries.length === 0) {
    return null;
  }
  const now = Date.now();
  const liveEntries = entries.filter(([, credential]) => {
    const expires = typeof credential.expires === "number" ? credential.expires : null;
    return expires == null || expires > now;
  });
  return liveEntries[0] ?? null;
}

async function resolveCodexCliChatGptTokens(configPath: string): Promise<CodexCliChatGptTokens | null> {
  const entry = pickLiveCodexOAuthEntry(await readPersistedCodexOAuthEntries(configPath));
  if (!entry) {
    return null;
  }
  const [, credential] = entry;
  return buildCodexCliChatGptTokens(credential);
}

function readCodexCliChatGptTokens(authJson: CodexCliAuthJson): CodexCliChatGptTokens | null {
  if (normalizeString(authJson.auth_mode)?.toLowerCase() !== "chatgpt" || !isRecord(authJson.tokens)) {
    return null;
  }
  const idToken = normalizeString(authJson.tokens.id_token);
  const accessToken = normalizeString(authJson.tokens.access_token);
  const refreshToken = normalizeString(authJson.tokens.refresh_token);
  const accountId = normalizeString(authJson.tokens.account_id);
  if (!idToken || !accessToken || !refreshToken) {
    return null;
  }
  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(accountId ? { account_id: accountId } : {}),
  };
}

function resolveJwtExpiryMs(token: string): number | null {
  const expiresAtSeconds = normalizeFutureEpochSeconds(decodeCodexJwtPayload(token)?.exp);
  return expiresAtSeconds ? expiresAtSeconds * 1000 : null;
}

function mergeCodexAuthIdentity(primaryToken: string, fallbackToken: string): ReturnType<typeof resolveCodexAuthIdentity> {
  const primary = resolveCodexAuthIdentity(primaryToken);
  const fallback = resolveCodexAuthIdentity(fallbackToken);
  return {
    email: primary.email ?? fallback.email,
    accountId: primary.accountId ?? fallback.accountId,
    chatgptPlanType: primary.chatgptPlanType ?? fallback.chatgptPlanType,
    profileName: primary.profileName ?? fallback.profileName,
  };
}

function findPersistedCredentialForTokens(
  entries: Array<[string, Record<string, unknown>]>,
  tokens: CodexCliChatGptTokens,
): Record<string, unknown> | null {
  return (
    entries.find(([, credential]) => normalizeString(credential.refresh) === tokens.refresh_token)?.[1] ??
    entries.find(([, credential]) => {
      const credentialAccountId = normalizeString(credential.accountId);
      return Boolean(tokens.account_id && credentialAccountId === tokens.account_id);
    })?.[1] ??
    null
  );
}

async function readCanonicalCodexAuthBundle(configPath: string): Promise<CodexAuthBundle> {
  const entries = await readPersistedCodexOAuthEntries(configPath);
  const authJson = await readCodexCliAuthJson();
  const cliTokens = readCodexCliChatGptTokens(authJson);
  if (cliTokens) {
    const credential = findPersistedCredentialForTokens(entries, cliTokens);
    const identity = mergeCodexAuthIdentity(cliTokens.id_token, cliTokens.access_token);
    const expiresAtMs =
      resolveJwtExpiryMs(cliTokens.access_token) ??
      (typeof credential?.expires === "number" ? credential.expires : null);
    if (!expiresAtMs || expiresAtMs <= Date.now()) {
      throw new Error("Saved OpenAI login is expired or missing an expiry. Start a new device login.");
    }
    const accountId = cliTokens.account_id ?? identity.accountId ?? normalizeString(credential?.accountId);
    const email = identity.email ?? normalizeString(credential?.email);
    const chatgptPlanType = identity.chatgptPlanType ?? normalizeString(credential?.chatgptPlanType);
    return {
      formatVersion: 1,
      profileId: buildAuthProfileId("openai", identity.profileName ?? email),
      accessToken: cliTokens.access_token,
      refreshToken: cliTokens.refresh_token,
      idToken: cliTokens.id_token,
      expiresAtMs,
      lastRefresh: normalizeString(authJson.last_refresh),
      email,
      accountId,
      chatgptPlanType,
    };
  }

  const entry = pickLiveCodexOAuthEntry(entries);
  if (!entry) {
    throw new Error("No reusable OpenAI login is available on this agent.");
  }
  const [, credential] = entry;
  const accessToken = normalizeString(credential.access);
  const refreshToken = normalizeString(credential.refresh);
  const expiresAtMs = typeof credential.expires === "number" ? credential.expires : null;
  if (!accessToken || !refreshToken || !expiresAtMs || expiresAtMs <= Date.now()) {
    throw new Error("Saved OpenAI login is incomplete or expired. Start a new device login.");
  }
  const identity = resolveCodexAuthIdentity(accessToken);
  const email = identity.email ?? normalizeString(credential.email);
  return {
    formatVersion: 1,
    profileId: buildAuthProfileId("openai", identity.profileName ?? email),
    accessToken,
    refreshToken,
    idToken: accessToken,
    expiresAtMs,
    lastRefresh: null,
    email,
    accountId: identity.accountId ?? normalizeString(credential.accountId),
    chatgptPlanType: identity.chatgptPlanType ?? normalizeString(credential.chatgptPlanType),
  };
}

async function snapshotFiles(filePaths: string[]): Promise<FileSnapshot[]> {
  return await Promise.all(
    Array.from(new Set(filePaths)).map(async (filePath): Promise<FileSnapshot> => {
      try {
        return { filePath, contents: await fs.readFile(filePath) };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return { filePath, contents: null };
        }
        throw error;
      }
    }),
  );
}

async function restoreFileSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.contents === null) {
      await fs.rm(snapshot.filePath, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(snapshot.filePath), { recursive: true });
    const tempPath = `${snapshot.filePath}.${process.pid}.${randomUUID()}.rollback`;
    try {
      await fs.writeFile(tempPath, snapshot.contents, { mode: 0o600 });
      await fs.rename(tempPath, snapshot.filePath);
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }
}

async function snapshotCodexRuntimeAuthStore(
  configPath: string,
): Promise<CodexRuntimeAuthSnapshot> {
  const databasePath = resolveCodexAuthProfileDatabasePath(configPath);
  try {
    await fs.access(databasePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        databaseExisted: false,
        storeTableExisted: false,
        stateTableExisted: false,
        storeRow: null,
        stateRow: null,
      };
    }
    throw error;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const tableExists = (name: string) =>
      Boolean(
        db
          .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name),
      );
    const storeTableExisted = tableExists("auth_profile_store");
    const stateTableExisted = tableExists("auth_profile_state");
    const store = storeTableExisted
      ? (db
          .prepare("SELECT store_json, updated_at FROM auth_profile_store WHERE store_key = ?")
          .get("primary") as { store_json?: string; updated_at?: number } | undefined)
      : undefined;
    const state = stateTableExisted
      ? (db
          .prepare("SELECT state_json, updated_at FROM auth_profile_state WHERE state_key = ?")
          .get("primary") as { state_json?: string; updated_at?: number } | undefined)
      : undefined;
    return {
      databaseExisted: true,
      storeTableExisted,
      stateTableExisted,
      storeRow:
        typeof store?.store_json === "string" && typeof store.updated_at === "number"
          ? { json: store.store_json, updatedAt: store.updated_at }
          : null,
      stateRow:
        typeof state?.state_json === "string" && typeof state.updated_at === "number"
          ? { json: state.state_json, updatedAt: state.updated_at }
          : null,
    };
  } finally {
    db.close();
  }
}

async function restoreCodexRuntimeAuthStore(
  configPath: string,
  snapshot: CodexRuntimeAuthSnapshot,
): Promise<void> {
  const databasePath = resolveCodexAuthProfileDatabasePath(configPath);
  if (!snapshot.databaseExisted) {
    await fs.rm(databasePath, { force: true });
    await fs.rm(`${databasePath}-shm`, { force: true });
    await fs.rm(`${databasePath}-wal`, { force: true });
    return;
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    try {
      if (snapshot.storeTableExisted) {
        if (snapshot.storeRow) {
          db.prepare(
            `INSERT INTO auth_profile_store (store_key, store_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at`,
          ).run("primary", snapshot.storeRow.json, snapshot.storeRow.updatedAt);
        } else {
          db.prepare("DELETE FROM auth_profile_store WHERE store_key = ?").run("primary");
        }
      } else {
        db.exec("DROP TABLE IF EXISTS auth_profile_store;");
      }
      if (snapshot.stateTableExisted) {
        if (snapshot.stateRow) {
          db.prepare(
            `INSERT INTO auth_profile_state (state_key, state_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
          ).run("primary", snapshot.stateRow.json, snapshot.stateRow.updatedAt);
        } else {
          db.prepare("DELETE FROM auth_profile_state WHERE state_key = ?").run("primary");
        }
      } else {
        db.exec("DROP TABLE IF EXISTS auth_profile_state;");
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function readCodexAuthSyncState(): Promise<CodexAuthSyncState | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(resolveCodexAuthSyncStatePath(), "utf8"));
    if (
      isRecord(parsed) &&
      parsed.formatVersion === 1 &&
      typeof parsed.bundleVersion === "number" &&
      typeof parsed.profileId === "string" &&
      typeof parsed.expiresAtMs === "number" &&
      typeof parsed.syncedAt === "string"
    ) {
      return parsed as CodexAuthSyncState;
    }
    return null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function applyCodexAuthBundle(input: {
  configPath: string;
  bundle: CodexAuthBundle;
  syncState?: CodexAuthSyncState;
}): Promise<CodexAuthImportActionResult> {
  if (input.bundle.expiresAtMs <= Date.now()) {
    throw new Error("Cannot import an expired OpenAI auth bundle.");
  }
  const identity = mergeCodexAuthIdentity(input.bundle.idToken, input.bundle.accessToken);
  const canonicalProfileId = buildAuthProfileId("openai", identity.profileName ?? identity.email);
  if (canonicalProfileId !== input.bundle.profileId) {
    throw new Error("OpenAI auth bundle profile does not match its signed token identity.");
  }
  const runtimeAuthSnapshot = await snapshotCodexRuntimeAuthStore(input.configPath);
  const snapshots = await snapshotFiles([
    input.configPath,
    ...resolveCodexAuthStorePaths(input.configPath),
    resolveCodexSessionsStorePath(input.configPath),
    resolveCodexCliAuthPath(),
    ...(input.syncState ? [resolveCodexAuthSyncStatePath()] : []),
  ]);
  try {
    const persisted = await persistCodexCredentials({
      configPath: input.configPath,
      creds: {
        access: input.bundle.accessToken,
        refresh: input.bundle.refreshToken,
        expires: input.bundle.expiresAtMs,
      },
      identityToken: input.bundle.idToken,
      profileId: input.bundle.profileId,
    });
    await writeCodexCliChatGptAuth(
      {
        id_token: input.bundle.idToken,
        access_token: input.bundle.accessToken,
        refresh_token: input.bundle.refreshToken,
        ...(input.bundle.accountId ? { account_id: input.bundle.accountId } : {}),
      },
      input.bundle.lastRefresh,
    );
    if (input.syncState) {
      await writeJsonFile(resolveCodexAuthSyncStatePath(), input.syncState);
    }
    const status = await readPersistedCodexStatus("codex.login.status", input.configPath);
    if (status.state !== "connected") {
      throw new Error(status.lastError ?? status.message);
    }
    return {
      kind: "codex.auth.import",
      applied: true,
      profileId: persisted.profileId,
      email: persisted.email,
      accountId: persisted.accountId,
      expiresAtMs: input.bundle.expiresAtMs,
      authModes: status.authModes,
    };
  } catch (error) {
    await restoreFileSnapshots(snapshots);
    await restoreCodexRuntimeAuthStore(input.configPath, runtimeAuthSnapshot);
    throw error;
  }
}

async function readPersistedCodexStatus(kind: "codex.login.start" | "codex.login.status", configPath: string): Promise<CodexLoginActionResult> {
  const entries = await readPersistedCodexOAuthEntries(configPath);
  if (entries.length === 0) {
    const authModes = await resolveCodexAuthModes({
      loginAvailable: false,
      loginMessage: "OpenAI login is not connected on this agent.",
    });
    return buildResult(kind, "not_logged_in", {
      message: "Codex is not connected on this agent yet.",
      authModes,
    });
  }
  const now = Date.now();
  const liveEntries = entries.filter(([, credential]) => {
    const expires = typeof credential.expires === "number" ? credential.expires : null;
    return expires == null || expires > now;
  });
  const pickEntry = liveEntries[0] ?? entries[0];
  const [profileId, credential] = pickEntry;
  const email = normalizeString(credential.email);
  const accountId = normalizeString(credential.accountId);
  const expires = typeof credential.expires === "number" ? credential.expires : null;
  if (liveEntries.length === 0) {
    const authModes = await resolveCodexAuthModes({
      loginAvailable: false,
      loginMessage: "Saved OpenAI login expired. Start a new device login.",
    });
    return buildResult(kind, "failed", {
      message: "Saved Codex login expired. Start a new device login.",
      profileId,
      email,
      accountId,
      expiresAtMs: expires,
      lastError: "expired_oauth_token",
      authModes,
    });
  }
  const loginMessage = email ? `Connected as ${email}.` : "OpenAI login is connected on this agent.";
  const authModes = await resolveCodexAuthModes({
    loginAvailable: true,
    loginMessage,
  });
  return buildResult(kind, "connected", {
    message: email ? `Connected as ${email}.` : "Codex is connected on this agent.",
    profileId,
    email,
    accountId,
    expiresAtMs: expires,
    authModes,
  });
}

async function snapshotPendingSession(kind: "codex.login.start" | "codex.login.status", session: PendingCodexLogin): Promise<CodexLoginActionResult> {
  if (session.state === "connected") {
    const loginMessage = session.email ? `Connected as ${session.email}.` : "OpenAI login is connected on this agent.";
    const authModes = await resolveCodexAuthModes({
      loginAvailable: true,
      loginMessage,
    });
    return buildResult(kind, "connected", {
      message: session.message,
      profileId: session.profileId,
      email: session.email,
      accountId: session.accountId,
      authModes,
    });
  }
  if (session.state === "failed") {
    const authModes = await resolveCodexAuthModes({
      loginAvailable: false,
      loginMessage: "OpenAI login is not connected on this agent.",
    });
    return buildResult(kind, "failed", {
      message: session.message,
      lastError: session.lastError,
      authModes,
    });
  }
  const authModes = await resolveCodexAuthModes({
    loginAvailable: false,
    loginMessage: "OpenAI login is pending on this agent.",
  });
  return buildResult(kind, "pending", {
    message: session.message,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    expiresAtMs: session.expiresAtMs,
    pollAfterMs: session.pollAfterMs,
    authModes,
  });
}

function startPendingCodexLogin(configPath: string): PendingCodexLogin {
  const deferred = createDeferred();
  const session: PendingCodexLogin = {
    state: "pending",
    message: "Starting OpenAI Codex device login…",
    verificationUrl: null,
    userCode: null,
    expiresAtMs: null,
    pollAfterMs: OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
    profileId: null,
    email: null,
    accountId: null,
    lastError: null,
    ready: deferred.promise,
    resolveReady: deferred.resolve,
  };
  pendingCodexLogin = session;

  void (async () => {
    try {
      const requested = await requestDeviceCode(fetch);
      session.message = "Open the verification page and enter the device code.";
      session.verificationUrl = requested.verificationUrl;
      session.userCode = requested.userCode;
      session.expiresAtMs = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;
      session.pollAfterMs = requested.intervalMs;
      session.resolveReady();

      const authorized = await pollDeviceAuthorization({
        fetchFn: fetch,
        deviceAuthId: requested.deviceAuthId,
        userCode: requested.userCode,
        intervalMs: requested.intervalMs,
      });
      const creds = await exchangeDeviceAuthorization({
        fetchFn: fetch,
        authorizationCode: authorized.authorizationCode,
        codeVerifier: authorized.codeVerifier,
      });
      const persisted = await persistCodexCredentials({ configPath, creds });
      await writeCodexCliChatGptAuth(persisted.tokens);
      session.state = "connected";
      session.message = persisted.email ? `Connected as ${persisted.email}.` : "Codex login complete.";
      session.verificationUrl = null;
      session.userCode = null;
      session.expiresAtMs = null;
      session.pollAfterMs = null;
      session.profileId = persisted.profileId;
      session.email = persisted.email;
      session.accountId = persisted.accountId;
      session.lastError = null;
    } catch (error) {
      session.state = "failed";
      session.message = "Codex login failed.";
      session.lastError = error instanceof Error ? error.message : String(error);
      session.pollAfterMs = null;
      session.resolveReady();
    }
  })();

  return session;
}

export async function startCodexLogin(
  configPath: string,
  options?: { forceRelink?: boolean },
): Promise<CodexLoginActionResult> {
  const existing = pendingCodexLogin;
  if (options?.forceRelink && existing?.state === "pending") {
    throw new Error("An OpenAI device login is already pending on this agent.");
  }
  if (options?.forceRelink) {
    pendingCodexLogin = null;
  }
  if (existing?.state === "pending") {
    await existing.ready;
    if (existing.state === "pending") {
      return await snapshotPendingSession("codex.login.start", existing);
    }
    return await snapshotPendingSession("codex.login.start", existing);
  }
  const session = startPendingCodexLogin(configPath);
  await session.ready;
  if (session.state === "pending") {
    return await snapshotPendingSession("codex.login.start", session);
  }
  return await snapshotPendingSession("codex.login.start", session);
}

export async function getCodexLoginStatus(configPath: string): Promise<CodexLoginActionResult> {
  if (pendingCodexLogin) {
    return await snapshotPendingSession("codex.login.status", pendingCodexLogin);
  }
  return await readPersistedCodexStatus("codex.login.status", configPath);
}

export async function setCodexAuthMode(configPath: string, mode: CodexAuthMode): Promise<CodexAuthSetActionResult> {
  const status = await getCodexLoginStatus(configPath);
  const authJson = await readCodexCliAuthJson();
  if (mode === "openai_login") {
    if (!status.authModes.openaiLogin.available) {
      throw new Error(status.authModes.openaiLogin.message);
    }
    const tokens = await resolveCodexCliChatGptTokens(configPath);
    if (!tokens) {
      throw new Error("Saved OpenAI login is incomplete. Start a new device login.");
    }
    await writeCodexCliChatGptAuth(tokens);
  } else {
    const apiKey = normalizeString(authJson.OPENAI_API_KEY) || normalizeString(process.env.OPENAI_API_KEY);
    if (!apiKey) {
      throw new Error(status.authModes.apiKey.message);
    }
    await writeCodexCliAuthJson({
      ...authJson,
      auth_mode: "apikey",
      OPENAI_API_KEY: apiKey,
    });
  }
  const nextStatus = await readPersistedCodexStatus("codex.login.status", configPath);
  return {
    kind: "codex.auth.set",
    mode,
    applied: true,
    authModes: nextStatus.authModes,
  };
}

export async function exportCodexAuthBundle(configPath: string): Promise<CodexAuthExportActionResult> {
  return {
    kind: "codex.auth.export",
    bundle: await readCanonicalCodexAuthBundle(configPath),
  };
}

export async function importCodexAuthBundle(
  configPath: string,
  bundle: CodexAuthBundle,
): Promise<CodexAuthImportActionResult> {
  const result = await applyCodexAuthBundle({ configPath, bundle });
  pendingCodexLogin = null;
  return result;
}

export async function syncCodexAuthBundle(
  configPath: string,
  bundleVersion: number,
  bundle: CodexAuthBundle,
): Promise<CodexAuthSyncActionResult> {
  const syncState = await readCodexAuthSyncState();
  const status = await readPersistedCodexStatus("codex.login.status", configPath);
  if (
    syncState &&
    syncState.profileId === bundle.profileId &&
    syncState.bundleVersion >= bundleVersion &&
    status.state === "connected" &&
    status.profileId === syncState.profileId
  ) {
    const currentBundle = await readCanonicalCodexAuthBundle(configPath);
    return {
      kind: "codex.auth.sync",
      applied: false,
      reason: "up_to_date",
      bundleVersion: syncState.bundleVersion,
      profileId: currentBundle.profileId,
      email: currentBundle.email,
      accountId: currentBundle.accountId,
      expiresAtMs: currentBundle.expiresAtMs,
      authModes: status.authModes,
    };
  }

  const imported = await applyCodexAuthBundle({
    configPath,
    bundle,
    syncState: {
      formatVersion: 1,
      bundleVersion,
      profileId: bundle.profileId,
      expiresAtMs: bundle.expiresAtMs,
      syncedAt: new Date().toISOString(),
    },
  });
  pendingCodexLogin = null;
  return {
    kind: "codex.auth.sync",
    applied: true,
    reason: "applied",
    bundleVersion,
    profileId: imported.profileId,
    email: imported.email,
    accountId: imported.accountId,
    expiresAtMs: imported.expiresAtMs,
    authModes: imported.authModes,
  };
}

function isOpenAiCredential(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "oauth" &&
    (value.provider === "openai" || value.provider === "openai-codex")
  );
}

async function clearCodexRuntimeAuthStore(configPath: string): Promise<void> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const databasePath = resolveCodexAuthProfileDatabasePath(configPath);
    try {
      await fs.access(databasePath);
    } catch {
      return;
    }
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA busy_timeout = 5000;");
      const rawStore = db.prepare("SELECT store_json FROM auth_profile_store WHERE store_key = ?").get("primary") as { store_json?: string } | undefined;
      if (rawStore?.store_json) {
        const store = readAuthProfilesStoreFromRaw(parseSqliteJsonCell(rawStore.store_json));
        store.profiles = Object.fromEntries(
          Object.entries(store.profiles).filter(([, value]) => !isOpenAiCredential(value)),
        );
        db.prepare("UPDATE auth_profile_store SET store_json = ?, updated_at = ? WHERE store_key = ?")
          .run(JSON.stringify(store), Date.now(), "primary");
      }
      const rawState = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary") as { state_json?: string } | undefined;
      if (rawState?.state_json) {
        const state = coerceAuthProfileStateStore(parseSqliteJsonCell(rawState.state_json));
        if (state.order) delete state.order.openai;
        if (state.lastGood) delete state.lastGood.openai;
        db.prepare("UPDATE auth_profile_state SET state_json = ?, updated_at = ? WHERE state_key = ?")
          .run(JSON.stringify(state), Date.now(), "primary");
      }
    } finally {
      db.close();
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export async function clearCodexAuth(configPath: string): Promise<CodexAuthClearActionResult> {
  for (const authStorePath of resolveCodexAuthStorePaths(configPath)) {
    const store = await readAuthProfilesStore(authStorePath);
    store.profiles = Object.fromEntries(
      Object.entries(store.profiles).filter(([, value]) => !isOpenAiCredential(value)),
    );
    await writeJsonFile(authStorePath, store);
  }
  await clearCodexRuntimeAuthStore(configPath);

  const config = await readConfigObject(configPath);
  const auth = isRecord(config.auth) ? { ...config.auth } : {};
  const profiles = isRecord(auth.profiles) ? { ...auth.profiles } : {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (isRecord(profile) && profile.provider === "openai" && profile.mode === "oauth") {
      delete profiles[profileId];
    }
  }
  const order = isRecord(auth.order) ? { ...auth.order } : {};
  delete order.openai;
  auth.profiles = profiles;
  auth.order = order;
  await writeJsonFile(configPath, { ...config, auth });

  const cliAuth = await readCodexCliAuthJson();
  const nextCliAuth = { ...cliAuth };
  delete nextCliAuth.tokens;
  delete nextCliAuth.last_refresh;
  if (normalizeString(nextCliAuth.auth_mode)?.toLowerCase() === "chatgpt") {
    if (normalizeString(nextCliAuth.OPENAI_API_KEY)) nextCliAuth.auth_mode = "apikey";
    else delete nextCliAuth.auth_mode;
  }
  await writeCodexCliAuthJson(nextCliAuth);
  await fs.rm(resolveCodexAuthSyncStatePath(), { force: true });
  pendingCodexLogin = null;
  return { kind: "codex.auth.clear", applied: true };
}

export async function hasConnectedCodexLogin(configPath: string): Promise<boolean> {
  const status = await getCodexLoginStatus(configPath);
  return status.state === "connected";
}
