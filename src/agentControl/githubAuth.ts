import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { AgentControlAction, AgentControlResult } from "./protocol.js";

const execFile = promisify(execFileCallback);
const GITHUB_DEVICE_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const GITHUB_VERIFICATION_URL = "https://github.com/login/device";
const GITHUB_DEVICE_CODE_DEFAULT_POLL_MS = 3_000;
const GITHUB_DEVICE_CODE_READY_TIMEOUT_MS = 2_500;

type GitHubCredentialState = "configured" | "pending" | "failed";

class GitHubAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitHubAuthError";
    this.code = code;
  }
}

type PendingGitHubOauthLogin = {
  state: "pending" | "configured" | "failed";
  campaignId: string;
  configPath: string;
  repositoryUrl: string;
  childExited: boolean;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  userCode: string | null;
  repositoryReachable: boolean | null;
  ready: Promise<void>;
  resolveReady: () => void;
};

let pendingGitHubOauthByCampaign = new Map<string, PendingGitHubOauthLogin>();

export const __testing = {
  resetGitHubOauthState(): void {
    pendingGitHubOauthByCampaign = new Map<string, PendingGitHubOauthLogin>();
  },
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function safeFileSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "campaign";
}

function resolveGitHubConfigPaths(campaignId: string): { configDir: string; campaignKey: string; configPath: string } {
  const configDir = path.join(os.homedir(), ".config", "golem-marketing", "github");
  const campaignKey = safeFileSegment(campaignId);
  return {
    configDir,
    campaignKey,
    configPath: path.join(configDir, `${campaignKey}.json`),
  };
}

async function writeSecureJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runGitLsRemote(input: {
  repositoryUrl: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean | null> {
  const repositoryUrl = input.repositoryUrl.trim();
  if (!repositoryUrl) return null;
  try {
    await execFile("git", ["ls-remote", "--heads", repositoryUrl], {
      timeout: 15_000,
      env: {
        ...process.env,
        ...(input.env ?? {}),
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return true;
  } catch {
    return false;
  }
}

function buildConfigureResult(params: {
  authMethod: "SSH_TOKEN" | "GITHUB_OAUTH";
  credentialState: GitHubCredentialState;
  message: string;
  repositoryReachable: boolean | null;
  configPath: string;
  verificationUrl?: string | null;
  userCode?: string | null;
  pollAfterMs?: number | null;
}): Extract<AgentControlResult, { kind: "github.auth.configure" }> {
  return {
    kind: "github.auth.configure",
    configured: true,
    authMethod: params.authMethod,
    credentialState: params.credentialState,
    message: params.message,
    repositoryReachable: params.repositoryReachable,
    configPath: params.configPath,
    verificationUrl: params.verificationUrl ?? null,
    userCode: params.userCode ?? null,
    pollAfterMs: params.pollAfterMs ?? null,
  };
}

function buildOauthStatusResult(params: {
  credentialState: GitHubCredentialState;
  message: string;
  repositoryReachable: boolean | null;
  configPath: string;
  verificationUrl?: string | null;
  userCode?: string | null;
  pollAfterMs?: number | null;
}): Extract<AgentControlResult, { kind: "github.oauth.status" }> {
  return {
    kind: "github.oauth.status",
    credentialState: params.credentialState,
    message: params.message,
    repositoryReachable: params.repositoryReachable,
    configPath: params.configPath,
    verificationUrl: params.verificationUrl ?? null,
    userCode: params.userCode ?? null,
    pollAfterMs: params.pollAfterMs ?? null,
  };
}

function snapshotConfigureOauthSession(
  session: PendingGitHubOauthLogin,
): Extract<AgentControlResult, { kind: "github.auth.configure" }> {
  const snapshot = snapshotPendingOauthSession(session);
  return buildConfigureResult({ ...snapshot, authMethod: "GITHUB_OAUTH" });
}

function snapshotOauthStatusSession(
  session: PendingGitHubOauthLogin,
): Extract<AgentControlResult, { kind: "github.oauth.status" }> {
  return buildOauthStatusResult(snapshotPendingOauthSession(session));
}

function snapshotPendingOauthSession(
  session: PendingGitHubOauthLogin,
): {
  credentialState: GitHubCredentialState;
  message: string;
  repositoryReachable: boolean | null;
  configPath: string;
  verificationUrl: string | null;
  userCode: string | null;
  pollAfterMs: number | null;
} {
  const failed = session.state === "failed" || (session.childExited && session.exitCode !== 0);
  const credentialState = failed ? "failed" : session.state;
  const message = failed
    ? session.stderr.trim() || "GitHub OAuth authorization failed on the agent."
    : session.userCode
      ? `Open ${GITHUB_VERIFICATION_URL} and enter code ${session.userCode}.`
      : "Waiting for GitHub OAuth authorization to start.";
  return {
    credentialState,
    message,
    repositoryReachable: session.repositoryReachable,
    configPath: session.configPath,
    verificationUrl: credentialState === "pending" || credentialState === "failed" ? GITHUB_VERIFICATION_URL : null,
    userCode: credentialState === "pending" || credentialState === "failed" ? session.userCode : null,
    pollAfterMs: credentialState === "pending" ? GITHUB_DEVICE_CODE_DEFAULT_POLL_MS : null,
  };
}

async function readPersistedOauthStatus(
  action: Extract<AgentControlAction, { kind: "github.oauth.status" }>,
): Promise<Extract<AgentControlResult, { kind: "github.oauth.status" }>> {
  const { configPath } = resolveGitHubConfigPaths(action.campaignId);
  const authStatus = await execFile("gh", ["auth", "status", "--hostname", "github.com"], {
    timeout: 10_000,
  }).then(
    () => true,
    () => false,
  );
  if (!authStatus) {
    return buildOauthStatusResult({
      credentialState: "pending",
      message: "Waiting for GitHub OAuth authorization to complete.",
      repositoryReachable: null,
      configPath,
      verificationUrl: GITHUB_VERIFICATION_URL,
      pollAfterMs: GITHUB_DEVICE_CODE_DEFAULT_POLL_MS,
    });
  }

  const repositoryReachable = await runGitLsRemote({ repositoryUrl: action.repositoryUrl });
  await writeSecureJson(configPath, {
    campaignId: action.campaignId,
    authMethod: "GITHUB_OAUTH",
    repositoryUrl: action.repositoryUrl,
    credentialState: "configured",
    repositoryReachable,
    configuredAt: new Date().toISOString(),
  });
  return buildOauthStatusResult({
    credentialState: "configured",
    message: "GitHub OAuth authorization completed on the agent.",
    repositoryReachable,
    configPath,
  });
}

function startPendingGitHubOauthLogin(input: {
  campaignId: string;
  repositoryUrl: string;
  configPath: string;
}): PendingGitHubOauthLogin {
  const deferred = createDeferred();
  const session: PendingGitHubOauthLogin = {
    state: "pending",
    campaignId: input.campaignId,
    configPath: input.configPath,
    repositoryUrl: input.repositoryUrl,
    childExited: false,
    exitCode: null,
    stderr: "",
    stdout: "",
    userCode: null,
    repositoryReachable: null,
    ready: deferred.promise,
    resolveReady: deferred.resolve,
  };
  pendingGitHubOauthByCampaign.set(input.campaignId, session);

  const child = spawn("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "ssh", "--web"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const markReadyIfCodePresent = () => {
    const match = GITHUB_DEVICE_CODE_RE.exec(`${session.stdout}\n${session.stderr}`);
    if (!match) {
      return;
    }
    session.userCode = match[1] ?? null;
    child.stdin?.write("\n");
    session.resolveReady();
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    session.stdout += chunk.toString("utf8");
    markReadyIfCodePresent();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    session.stderr += chunk.toString("utf8");
    markReadyIfCodePresent();
  });
  child.on("exit", (code) => {
    session.childExited = true;
    session.exitCode = code;
    if (code !== 0) {
      session.state = "failed";
    }
    session.resolveReady();
  });
  setTimeout(session.resolveReady, GITHUB_DEVICE_CODE_READY_TIMEOUT_MS);
  return session;
}

async function configureGitHubSshAuth(
  action: Extract<AgentControlAction, { kind: "github.auth.configure" }>,
): Promise<Extract<AgentControlResult, { kind: "github.auth.configure" }>> {
  const { configDir, campaignKey, configPath } = resolveGitHubConfigPaths(action.campaignId);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const sshPrivateKey = action.sshPrivateKey?.trim();
  if (!sshPrivateKey) {
    throw new GitHubAuthError("GITHUB_SSH_KEY_MISSING", "SSH token or private key is required.");
  }
  const keyPath = path.join(configDir, `${campaignKey}.key`);
  await fs.writeFile(keyPath, `${sshPrivateKey}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(keyPath, 0o600);
  const gitSshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const repositoryReachable = await runGitLsRemote({
    repositoryUrl: action.repositoryUrl,
    env: { GIT_SSH_COMMAND: gitSshCommand },
  });
  await writeSecureJson(configPath, {
    campaignId: action.campaignId,
    authMethod: action.authMethod,
    githubAccount: action.githubAccount.trim(),
    repositoryUrl: action.repositoryUrl.trim(),
    keyPath,
    credentialState: "configured",
    repositoryReachable,
    configuredAt: new Date().toISOString(),
  });
  return buildConfigureResult({
    authMethod: action.authMethod,
    credentialState: "configured",
    message: repositoryReachable === false
      ? "SSH key was stored, but repository reachability check failed."
      : "SSH GitHub access was configured on the agent.",
    repositoryReachable,
    configPath,
  });
}

async function configureGitHubOauthToken(
  action: Extract<AgentControlAction, { kind: "github.auth.configure" }>,
): Promise<Extract<AgentControlResult, { kind: "github.auth.configure" }>> {
  const { configDir, campaignKey, configPath } = resolveGitHubConfigPaths(action.campaignId);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const accessToken = action.accessToken?.trim();
  if (!accessToken) {
    const existing = pendingGitHubOauthByCampaign.get(action.campaignId);
    const session = existing?.state === "pending"
      ? existing
      : startPendingGitHubOauthLogin({
          campaignId: action.campaignId,
          repositoryUrl: action.repositoryUrl,
          configPath,
        });
    await session.ready;
    await writeSecureJson(configPath, {
      campaignId: action.campaignId,
      authMethod: action.authMethod,
      githubAccount: action.githubAccount.trim(),
      repositoryUrl: action.repositoryUrl.trim(),
      credentialState: session.state,
      repositoryReachable: session.repositoryReachable,
      verificationUrl: GITHUB_VERIFICATION_URL,
      userCode: session.userCode,
      configuredAt: new Date().toISOString(),
    });
    return snapshotConfigureOauthSession(session);
  }

  const tokenPath = path.join(configDir, `${campaignKey}.token`);
  await fs.writeFile(tokenPath, `${accessToken}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tokenPath, 0o600);
  const repositoryReachable = await runGitLsRemote({
    repositoryUrl: action.repositoryUrl,
    env: {
      GH_TOKEN: accessToken,
      GITHUB_TOKEN: accessToken,
    },
  });
  await writeSecureJson(configPath, {
    campaignId: action.campaignId,
    authMethod: action.authMethod,
    githubAccount: action.githubAccount.trim(),
    repositoryUrl: action.repositoryUrl.trim(),
    tokenPath,
    credentialState: "configured",
    repositoryReachable,
    configuredAt: new Date().toISOString(),
  });
  return buildConfigureResult({
    authMethod: action.authMethod,
    credentialState: "configured",
    message: "GitHub OAuth token was stored on the agent.",
    repositoryReachable,
    configPath,
  });
}

export async function configureGitHubAuth(
  action: Extract<AgentControlAction, { kind: "github.auth.configure" }>
): Promise<Extract<AgentControlResult, { kind: "github.auth.configure" }>> {
  if (action.authMethod === "SSH_TOKEN") {
    return await configureGitHubSshAuth(action);
  }
  if (action.authMethod === "GITHUB_OAUTH") {
    return await configureGitHubOauthToken(action);
  }
  throw new GitHubAuthError("GITHUB_AUTH_METHOD_UNSUPPORTED", "Unsupported GitHub authorization method.");
}

export async function getGitHubOauthStatus(
  action: Extract<AgentControlAction, { kind: "github.oauth.status" }>
): Promise<Extract<AgentControlResult, { kind: "github.oauth.status" }>> {
  const pending = pendingGitHubOauthByCampaign.get(action.campaignId);
  if (pending) {
    const authStatus = await execFile("gh", ["auth", "status", "--hostname", "github.com"], {
      timeout: 10_000,
    }).then(
      () => true,
      () => false,
    );
    if (authStatus) {
      pending.state = "configured";
      pending.repositoryReachable = await runGitLsRemote({ repositoryUrl: action.repositoryUrl });
      pendingGitHubOauthByCampaign.delete(action.campaignId);
      await writeSecureJson(pending.configPath, {
        campaignId: action.campaignId,
        authMethod: "GITHUB_OAUTH",
        repositoryUrl: action.repositoryUrl,
        credentialState: "configured",
        repositoryReachable: pending.repositoryReachable,
        configuredAt: new Date().toISOString(),
      });
    }
    return snapshotOauthStatusSession(pending);
  }
  return await readPersistedOauthStatus(action);
}
