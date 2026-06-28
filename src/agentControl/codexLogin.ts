import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.5";
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const AUTH_PROFILES_FILE = "auth-profiles.json";
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
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveCodexAuthStorePaths(configPath: string): string[] {
  const stateDir = path.dirname(configPath);
  return [path.join(stateDir, AUTH_PROFILES_FILE), path.join(stateDir, "agents", MAIN_AGENT_ID, "agent", AUTH_PROFILES_FILE)];
}

function resolveCodexCliAuthPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
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

function mergeProviderOrder(existing: unknown, profileId: string): string[] {
  const normalized = Array.isArray(existing) ? existing.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  return [profileId, ...normalized.filter((item) => item !== profileId)];
}

function upsertAuthProfileFirst(profiles: AuthProfilesStore["profiles"], profileId: string, credential: OAuthCredential): AuthProfilesStore["profiles"] {
  return {
    [profileId]: credential,
    ...Object.fromEntries(Object.entries(profiles).filter(([existingProfileId]) => existingProfileId !== profileId)),
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
      store.profiles = upsertAuthProfileFirst(store.profiles, input.profileId, input.credential);

      const rawState = db.prepare("SELECT state_json FROM auth_profile_state WHERE state_key = ?").get("primary") as { state_json?: string } | undefined;
      const state = coerceAuthProfileStateStore(parseSqliteJsonCell(rawState?.state_json));
      state.order = {
        ...state.order,
        openai: mergeProviderOrder(state.order?.openai, input.profileId),
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

async function persistCodexCredentials(input: { configPath: string; creds: DeviceCodeCredentials }): Promise<{
  profileId: string;
  email: string | null;
  accountId: string | null;
  tokens: CodexCliChatGptTokens;
}> {
  const identity = resolveCodexAuthIdentity(input.creds.access);
  const profileId = buildAuthProfileId("openai", identity.profileName);
  const credential = buildOAuthCredential({ creds: input.creds, identity });
  const tokens = buildCodexCliChatGptTokens(credential);
  if (!tokens) {
    throw new Error("OpenAI OAuth token exchange response was incomplete.");
  }
  for (const authStorePath of resolveCodexAuthStorePaths(input.configPath)) {
    const authStore = await readAuthProfilesStore(authStorePath);
    authStore.profiles = upsertAuthProfileFirst(authStore.profiles, profileId, credential);
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

  const nextConfig = {
    ...currentConfig,
    auth: {
      ...currentAuth,
      profiles: {
        ...currentProfiles,
        [profileId]: {
          provider: "openai",
          mode: "oauth",
          ...(identity.email ? { email: identity.email } : {}),
        },
      },
      order: {
        ...currentOrder,
        openai: mergeProviderOrder(currentOrder.openai, profileId),
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

async function writeCodexCliChatGptAuth(tokens: CodexCliChatGptTokens): Promise<void> {
  const authJson = await readCodexCliAuthJson();
  const chatGptAuthJson = { ...authJson };
  delete chatGptAuthJson.OPENAI_API_KEY;
  await writeCodexCliAuthJson({
    ...chatGptAuthJson,
    auth_mode: "chatgpt",
    tokens,
    last_refresh: new Date().toISOString(),
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

export async function startCodexLogin(configPath: string): Promise<CodexLoginActionResult> {
  const existing = pendingCodexLogin;
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

export async function hasConnectedCodexLogin(configPath: string): Promise<boolean> {
  const status = await getCodexLoginStatus(configPath);
  return status.state === "connected";
}
