import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as codexLoginTesting } from "./codexLogin.js";
import { __testing as githubAuthTesting } from "./githubAuth.js";
import { executeAgentControl } from "./executeAgentControl.js";

const noopGateway = {
  request: () => {
    throw new Error("gateway should not be called");
  },
};

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalRelayEnvPath = process.env.RELAY_ENV_PATH;
const originalFetch = global.fetch;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalRelayEnvPath === undefined) {
    delete process.env.RELAY_ENV_PATH;
  } else {
    process.env.RELAY_ENV_PATH = originalRelayEnvPath;
  }
  global.fetch = originalFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  vi.restoreAllMocks();
  codexLoginTesting.resetCodexLoginState();
  githubAuthTesting.resetGitHubOauthState();
});

async function createTempStateDir() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-pairing-"));
  const stateDir = path.join(tempDir, ".openclaw");
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { tempDir, stateDir, credentialsDir };
}

async function installFakeSystemctl() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-systemctl-"));
  const scriptPath = path.join(binDir, "systemctl");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -eu
if [ "$#" -ge 3 ] && [ "$1" = "--user" ] && [ "$2" = "restart" ] && [ "$3" = "openclaw-gateway.service" ]; then
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = "restart" ] && [ "$2" = "golem-workers-relay" ]; then
  exit 0
fi
if [ "$#" -ge 6 ] && [ "$1" = "--user" ] && [ "$2" = "show" ] && [ "$3" = "openclaw-gateway.service" ] && [ "$4" = "-p" ] && [ "$6" = "--value" ]; then
  case "$5" in
    ActiveState) printf 'active\\n' ;;
    SubState) printf 'running\\n' ;;
    Result) printf 'success\\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
    "utf8"
  );
  fsSync.chmodSync(scriptPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

describe("executeAgentControl relay self nudge settings", () => {
  it("writes relay env settings and schedules relay restart", async () => {
    vi.useFakeTimers();
    await installFakeSystemctl();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-env-"));
    const envPath = path.join(tempDir, ".env");
    const configPath = path.join(tempDir, "openclaw.json");
    process.env.RELAY_ENV_PATH = envPath;
    await fs.writeFile(envPath, "RELAY_TOKEN=t\nRELAY_SELF_NUDGE_ENABLED=0\n", "utf8");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        golemWorkers: {
          selfNudge: {
            enabled: true,
          },
        },
        channels: {
          "relay-channel": {
            nudge: {
              enabled: true,
            },
          },
        },
      }),
      "utf8"
    );

    const result = await executeAgentControl({
      action: {
        kind: "relay.selfNudge.set",
        settings: {
          enabled: true,
          analyzedRecentMessageCount: 2,
          baseTimeoutMs: 600_000,
          model: "openrouter/google/gemini-2.5-flash",
          debugMessagesEnabled: true,
        },
      },
      configPath,
      gateway: noopGateway,
    });

    expect(result).toEqual({
      kind: "relay.selfNudge.set",
      applied: true,
      restartScheduled: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runOnlyPendingTimersAsync();
    await expect(fs.readFile(envPath, "utf8")).resolves.toContain("RELAY_SELF_NUDGE_ENABLED=1");
    await expect(fs.readFile(envPath, "utf8")).resolves.toContain(
      "RELAY_SELF_NUDGE_ANALYZED_RECENT_MESSAGE_COUNT=2"
    );
    await expect(fs.readFile(envPath, "utf8")).resolves.toContain("RELAY_SELF_NUDGE_BASE_TIMEOUT_MS=600000");
    await expect(fs.readFile(envPath, "utf8")).resolves.toContain(
      "RELAY_SELF_NUDGE_MODEL=openrouter/google/gemini-2.5-flash"
    );
    await expect(fs.readFile(envPath, "utf8")).resolves.toContain("DEBUG_NUDGE=1");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      golemWorkers?: unknown;
      channels: Record<string, { nudge?: unknown }>;
    };
    expect(config.golemWorkers).toBeUndefined();
    expect(config.channels["relay-channel"]?.nudge).toBeUndefined();
  });
});

describe("executeAgentControl status nudge", () => {
  it("runs a status nudge through the chat runner and submits a reply callback", async () => {
    const submitInboundMessage = vi.fn().mockResolvedValue({ accepted: true });
    const runChatTask = vi.fn().mockResolvedValue({
      result: {
        outcome: "reply",
        reply: { runId: "run_status_1", message: { role: "assistant", content: "Still working." } },
      },
      openclawMeta: { method: "chat.send", runId: "run_status_1" },
    });

    const result = await executeAgentControl({
      action: {
        kind: "chat.statusNudge",
        sessionKey: "tg:123:srv_1",
        messageText: "report status",
        sourceBackendMessageId: "source_1",
        timeoutMs: 10_000,
      },
      configPath: "/tmp/openclaw.json",
      gateway: noopGateway,
      backend: { submitInboundMessage },
      relayInstanceId: "relay_1",
      backendMessageId: "nudge_1",
      statusNudgeRunner: { runChatTask },
    });

    expect(result).toEqual({ kind: "chat.statusNudge", accepted: true, runId: "run_status_1" });
    expect(runChatTask).toHaveBeenCalledWith({
      taskId: "nudge_1",
      sessionKey: "tg:123:srv_1",
      messageText: "report status",
      deliverySystem: "relay_channel_v2",
      timeoutMs: 10_000,
    });
    const submitArg = submitInboundMessage.mock.calls[0]?.[0] as {
      body?: {
        relayInstanceId?: string;
        outcome?: string;
        reply?: unknown;
        openclawMeta?: {
          sessionKey?: string;
          deliverySystem?: string;
          statusNudge?: { sourceBackendMessageId?: string };
          trace?: {
            backendMessageId?: string;
            relayInstanceId?: string;
            openclawRunId?: string;
          };
        };
      };
    };
    expect(submitArg.body?.relayInstanceId).toBe("relay_1");
    expect(submitArg.body?.outcome).toBe("reply");
    expect(submitArg.body?.reply).toEqual({
      runId: "run_status_1",
      message: { role: "assistant", content: "Still working." },
    });
    expect(submitArg.body?.openclawMeta).toMatchObject({
      sessionKey: "tg:123:srv_1",
      deliverySystem: "relay_channel_v2",
      statusNudge: { sourceBackendMessageId: "source_1" },
      trace: {
        backendMessageId: "nudge_1",
        relayInstanceId: "relay_1",
        openclawRunId: "run_status_1",
      },
    });
  });

  it("rejects status nudges when runtime dependencies are unavailable", async () => {
    await expect(
      executeAgentControl({
        action: {
          kind: "chat.statusNudge",
          sessionKey: "tg:123:srv_1",
          messageText: "report status",
          sourceBackendMessageId: "source_1",
        },
        configPath: "/tmp/openclaw.json",
        gateway: noopGateway,
      })
    ).rejects.toMatchObject({
      code: "STATUS_NUDGE_UNAVAILABLE",
    });
  });
});

describe("executeAgentControl channel pairing", () => {
  it("lists pending telegram pairing requests from the OpenClaw pairing store", async () => {
    const { credentialsDir } = await createTempStateDir();
    const createdAt = new Date().toISOString();
    await fs.writeFile(
      path.join(credentialsDir, "telegram-pairing.json"),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: "449985919",
            code: "ABCD2345",
            createdAt,
            meta: {
              username: "belbix",
              accountId: "default",
            },
          },
        ],
      }),
      "utf8"
    );

    const result = await executeAgentControl({
      action: { kind: "channelPairing.list", channel: "telegram" },
      configPath: path.join(credentialsDir, "..", "openclaw.json"),
      gateway: noopGateway,
    });

    expect(result).toEqual({
      kind: "channelPairing.list",
      requests: [
        {
          id: "449985919",
          code: "ABCD2345",
          createdAt,
          meta: {
            username: "belbix",
            accountId: "default",
          },
        },
      ],
    });
  });

  it("approves telegram pairing requests and appends the sender to allowFrom", async () => {
    const { credentialsDir } = await createTempStateDir();
    const createdAt = new Date().toISOString();
    await fs.writeFile(
      path.join(credentialsDir, "telegram-pairing.json"),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: "449985919",
            code: "ABCD2345",
            createdAt,
            meta: {
              username: "belbix",
              accountId: "default",
            },
          },
        ],
      }),
      "utf8"
    );

    const result = await executeAgentControl({
      action: { kind: "channelPairing.approve", channel: "telegram", code: "ABCD2345" },
      configPath: path.join(credentialsDir, "..", "openclaw.json"),
      gateway: noopGateway,
    });

    const pairingStore = JSON.parse(
      await fs.readFile(path.join(credentialsDir, "telegram-pairing.json"), "utf8")
    ) as { requests: unknown[] };
    const allowFromStore = JSON.parse(
      await fs.readFile(path.join(credentialsDir, "telegram-default-allowFrom.json"), "utf8")
    ) as { allowFrom: string[] };

    expect(result).toEqual({
      kind: "channelPairing.approve",
      approved: true,
      payload: {
        id: "449985919",
        code: "ABCD2345",
        entry: {
          id: "449985919",
          code: "ABCD2345",
          createdAt,
          meta: {
            username: "belbix",
            accountId: "default",
          },
        },
      },
    });
    expect(pairingStore.requests).toEqual([]);
    expect(allowFromStore.allowFrom).toEqual(["449985919"]);
  });
});

describe("executeAgentControl WhatsApp login", () => {
  it("starts WhatsApp QR login via gateway RPC", async () => {
    const gateway = {
      request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => {
        expect(method).toBe("web.login.start");
        expect(params).toEqual({ force: true, timeoutMs: 15_000 });
        expect(options).toEqual({ timeoutMs: 30_000 });
        return Promise.resolve({
          qrDataUrl: "data:image/png;base64,abc123",
          message: "Scan this QR in WhatsApp → Linked Devices.",
        });
      },
    };

    const result = await executeAgentControl({
      action: { kind: "whatsapp.login.start", forceRelink: true, timeoutMs: 15_000 },
      configPath: "/tmp/openclaw.json",
      gateway,
    });

    expect(result).toEqual({
      kind: "whatsapp.login.start",
      qrDataUrl: "data:image/png;base64,abc123",
      message: "Scan this QR in WhatsApp → Linked Devices.",
    });
  });

  it("waits for WhatsApp QR login completion via gateway RPC", async () => {
    const gateway = {
      request: (method: string, params?: unknown) => {
        expect(method).toBe("web.login.wait");
        expect(params).toEqual({ timeoutMs: 5_000 });
        return Promise.resolve({
          connected: true,
          message: "Linked!",
        });
      },
    };

    const result = await executeAgentControl({
      action: { kind: "whatsapp.login.wait", timeoutMs: 5_000 },
      configPath: "/tmp/openclaw.json",
      gateway,
    });

    expect(result).toEqual({
      kind: "whatsapp.login.wait",
      connected: true,
      message: "Linked!",
    });
  });
});

describe("executeAgentControl Codex login", () => {
  it("starts device-code login and reports the verification details", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-codex-login-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");

    let tokenPollResolve!: (value: Response) => void;
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({
            device_auth_id: "device-auth-123",
            user_code: "CODE-1234",
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return await new Promise<Response>((resolve) => {
          tokenPollResolve = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const startResult = await executeAgentControl({
      action: { kind: "codex.login.start" },
      configPath,
      gateway: noopGateway,
    });

    expect(startResult).toEqual({
      kind: "codex.login.start",
      state: "pending",
      message: "Open the verification page and enter the device code.",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CODE-1234",
      expiresAtMs: expect.any(Number) as number,
      pollAfterMs: 5000,
      profileId: null,
      email: null,
      accountId: null,
      lastError: null,
    });

    tokenPollResolve(
      new Response(
        JSON.stringify({
          error: "authorization_pending",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("persists a successful Codex login into auth-profiles and config bindings", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-codex-login-success-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");

    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return new Response(
          JSON.stringify({
            device_auth_id: "device-auth-123",
            user_code: "CODE-1234",
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return new Response(
          JSON.stringify({
            authorization_code: "auth-code-123",
            code_verifier: "verifier-123",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token:
              "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQ3MDAwMDAwMDAsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vcHJvZmlsZSI6eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifSwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfYWNjb3VudF9pZCI6ImFjY3QtMTIzIiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIn19.signature",
            refresh_token: "refresh-token-123",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const startResult = await executeAgentControl({
      action: { kind: "codex.login.start" },
      configPath,
      gateway: noopGateway,
    });
    expect(startResult.kind).toBe("codex.login.start");

    let statusResult = await executeAgentControl({
      action: { kind: "codex.login.status" },
      configPath,
      gateway: noopGateway,
    });
    for (let attempt = 0; attempt < 20 && statusResult.state !== "connected"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      statusResult = await executeAgentControl({
        action: { kind: "codex.login.status" },
        configPath,
        gateway: noopGateway,
      });
    }

    expect(statusResult).toEqual({
      kind: "codex.login.status",
      state: "connected",
      message: "Connected as user@example.com.",
      verificationUrl: null,
      userCode: null,
      expiresAtMs: null,
      pollAfterMs: null,
      profileId: "openai:user@example.com",
      email: "user@example.com",
      accountId: "acct-123",
      lastError: null,
    });

    const authProfiles = JSON.parse(
      await fs.readFile(path.join(tempDir, "auth-profiles.json"), "utf8"),
    ) as {
      version: number;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(authProfiles.version).toBe(1);
    expect(authProfiles.profiles["openai:user@example.com"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      refresh: "refresh-token-123",
      email: "user@example.com",
      accountId: "acct-123",
      chatgptPlanType: "plus",
    });
    const agentAuthProfiles = JSON.parse(
      await fs.readFile(path.join(tempDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ) as {
      version: number;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(agentAuthProfiles.version).toBe(1);
    expect(agentAuthProfiles.profiles["openai:user@example.com"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      refresh: "refresh-token-123",
      email: "user@example.com",
      accountId: "acct-123",
      chatgptPlanType: "plus",
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      auth?: {
        profiles?: Record<string, unknown>;
        order?: Record<string, string[]>;
      };
      agents?: {
        defaults?: {
          models?: Record<string, unknown>;
        };
      };
    };
    expect(config.auth?.profiles?.["openai:user@example.com"]).toEqual({
      provider: "openai",
      mode: "oauth",
      email: "user@example.com",
    });
    expect(config.auth?.order?.openai).toEqual(["openai:user@example.com"]);
    expect(config.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({ agentRuntime: { id: "codex" } });
  });

  it("reports connected Codex status when the OAuth profile only exists in the agent auth store", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-codex-login-agent-store-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");
    await fs.mkdir(path.join(tempDir, "agents", "main", "agent"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:user@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              email: "user@example.com",
              accountId: "acct-123",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const statusResult = await executeAgentControl({
      action: { kind: "codex.login.status" },
      configPath,
      gateway: noopGateway,
    });

    expect(statusResult).toEqual({
      kind: "codex.login.status",
      state: "connected",
      message: "Connected as user@example.com.",
      verificationUrl: null,
      userCode: null,
      expiresAtMs: expect.any(Number) as number,
      pollAfterMs: null,
      profileId: "openai-codex:user@example.com",
      email: "user@example.com",
      accountId: "acct-123",
      lastError: null,
    });
  });
});

describe("executeAgentControl GitHub auth", () => {
  it("generates a repository deploy key on the agent without returning a private key", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-github-deploy-key-"));
    process.env.HOME = tempHome;

    const result = await executeAgentControl({
      action: {
        kind: "github.auth.configure",
        campaignId: "mcamp_deploy",
        authMethod: "SSH_TOKEN",
        githubAccount: "",
        repositoryUrl: "",
      },
      configPath: path.join(tempHome, "openclaw.json"),
      gateway: noopGateway,
    });

    expect(result).toMatchObject({
      kind: "github.auth.configure",
      configured: true,
      authMethod: "SSH_TOKEN",
      credentialState: "pending",
      repositoryReachable: null,
      deployPublicKey: expect.stringMatching(/^ssh-ed25519 /) as string,
    });
    expect(result.kind).toBe("github.auth.configure");
    if (result.kind !== "github.auth.configure") {
      throw new Error("Unexpected GitHub auth result kind");
    }
    const stored = JSON.parse(await fs.readFile(result.configPath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      campaignId: "mcamp_deploy",
      authMethod: "SSH_TOKEN",
      credentialState: "pending",
    });
    expect(String(stored.keyPath)).toContain("mcamp_deploy.key");
    await expect(fs.readFile(String(stored.keyPath), "utf8")).resolves.toContain("PRIVATE KEY");
  });

  it("stores GitHub OAuth token metadata for a marketing campaign", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-github-auth-"));
    process.env.HOME = tempHome;

    const result = await executeAgentControl({
      action: {
        kind: "github.auth.configure",
        campaignId: "mcamp_1",
        authMethod: "GITHUB_OAUTH",
        githubAccount: "golem-marketing-agent",
        repositoryUrl: "",
        accessToken: "gho_test_token",
      },
      configPath: path.join(tempHome, "openclaw.json"),
      gateway: noopGateway,
    });

    expect(result).toEqual({
      kind: "github.auth.configure",
      configured: true,
      authMethod: "GITHUB_OAUTH",
      credentialState: "configured",
      message: "GitHub OAuth token was stored on the agent.",
      repositoryReachable: null,
      configPath: path.join(tempHome, ".config", "golem-marketing", "github", "mcamp_1.json"),
      verificationUrl: null,
      userCode: null,
      pollAfterMs: null,
      deployPublicKey: null,
    });
    expect(result.kind).toBe("github.auth.configure");
    if (result.kind !== "github.auth.configure") {
      throw new Error("Unexpected GitHub auth result kind");
    }
    const stored = JSON.parse(await fs.readFile(result.configPath, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      campaignId: "mcamp_1",
      authMethod: "GITHUB_OAUTH",
      githubAccount: "golem-marketing-agent",
      repositoryUrl: "",
      credentialState: "configured",
    });
  });
});

describe("executeAgentControl channels status", () => {
  it("reads OpenClaw channel runtime snapshot through the active gateway client", async () => {
    const gateway = {
      request: (method: string, params?: unknown, options?: { timeoutMs?: number }) => {
        expect(method).toBe("channels.status");
        expect(params).toEqual({ probe: false, timeoutMs: 10_000 });
        expect(options).toEqual({ timeoutMs: 15_000 });
        return Promise.resolve({
          channels: {
            telegram: {
              configured: true,
            },
          },
          channelAccounts: {
            telegram: [
              {
                accountId: "mybot",
                connected: true,
              },
            ],
          },
        });
      },
    };

    const result = await executeAgentControl({
      action: { kind: "channels.status" },
      configPath: "/tmp/openclaw.json",
      gateway,
    });

    expect(result).toEqual({
      kind: "channels.status",
      snapshot: {
        channels: {
          telegram: {
            configured: true,
          },
        },
        channelAccounts: {
          telegram: [
            {
              accountId: "mybot",
              connected: true,
            },
          ],
        },
      },
    });
  });
});

describe("executeAgentControl model set", () => {
  it("writes thinkingDefault for reasoning-capable models", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-set-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await installFakeSystemctl();
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");

    const result = await executeAgentControl({
      action: {
        kind: "model.set",
        model: "openrouter/google/gemini-3.1-pro-preview",
        fallbacks: ["openrouter/google/gemini-3-flash-preview", "openrouter/meta-llama/llama-4-scout"],
        contextTokens: 300000,
        thinkingDefault: "minimal",
      },
      configPath,
      gateway: noopGateway,
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: {
        defaults?: {
          model?: { primary?: string; fallbacks?: string[] };
          models?: Record<string, unknown>;
          contextTokens?: number;
          thinkingDefault?: string;
        };
      };
    };
    expect(result).toMatchObject({
      kind: "model.set",
      model: "openrouter/google/gemini-3.1-pro-preview",
      fallbacks: ["openrouter/google/gemini-3-flash-preview", "openrouter/meta-llama/llama-4-scout"],
      contextTokens: 300000,
      thinkingDefault: "minimal",
      activeState: "active",
      subState: "running",
      result: "success",
    });
    expect(config.agents?.defaults?.model?.primary).toBe("openrouter/google/gemini-3.1-pro-preview");
    expect(config.agents?.defaults?.model?.fallbacks).toEqual([
      "openrouter/google/gemini-3-flash-preview",
      "openrouter/meta-llama/llama-4-scout",
    ]);
    expect(config.agents?.defaults?.models?.["openrouter/google/gemini-3.1-pro-preview"]).toEqual({});
    expect(config.agents?.defaults?.models?.["openrouter/google/gemini-3-flash-preview"]).toEqual({});
    expect(config.agents?.defaults?.models?.["openrouter/meta-llama/llama-4-scout"]).toEqual({});
    expect(config.agents?.defaults?.contextTokens).toBe(300000);
    expect(config.agents?.defaults?.thinkingDefault).toBe("minimal");
  });

  it("removes stale thinkingDefault when reasoning is disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-unset-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await installFakeSystemctl();
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: { defaults: { thinkingDefault: "minimal" } } }, null, 2),
      "utf8"
    );

    const result = await executeAgentControl({
      action: {
        kind: "model.set",
        model: "openrouter/google/gemini-2.5-flash",
        fallbacks: ["openrouter/google/gemini-3-flash-preview", "openrouter/meta-llama/llama-4-scout"],
        contextTokens: 300000,
        thinkingDefault: null,
      },
      configPath,
      gateway: noopGateway,
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: { defaults?: { thinkingDefault?: string } };
    };
    expect(result).toMatchObject({
      kind: "model.set",
      model: "openrouter/google/gemini-2.5-flash",
      fallbacks: ["openrouter/google/gemini-3-flash-preview", "openrouter/meta-llama/llama-4-scout"],
      thinkingDefault: null,
    });
    expect(config.agents?.defaults?.thinkingDefault).toBeUndefined();
  });

  it("keeps public codex model refs when a Codex OAuth login is saved", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-codex-oauth-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await installFakeSystemctl();
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");
    await fs.writeFile(
      path.join(tempDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:user@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              email: "user@example.com",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await executeAgentControl({
      action: {
        kind: "model.set",
        model: "codex/gpt-5.3-codex",
        fallbacks: ["codex/gpt-5.4", "openrouter/google/gemini-3-flash-preview"],
        contextTokens: 272000,
        thinkingDefault: "high",
      },
      configPath,
      gateway: noopGateway,
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: {
        defaults?: {
          model?: { primary?: string; fallbacks?: string[] };
          models?: Record<string, unknown>;
        };
      };
    };

    expect(result).toMatchObject({
      kind: "model.set",
      model: "codex/gpt-5.3-codex",
      fallbacks: ["codex/gpt-5.4", "openrouter/google/gemini-3-flash-preview"],
      contextTokens: 272000,
      thinkingDefault: "high",
    });
    expect(config.agents?.defaults?.model?.primary).toBe("openai/gpt-5.3-codex");
    expect(config.agents?.defaults?.model?.fallbacks).toEqual([
      "openai/gpt-5.4",
      "openrouter/google/gemini-3-flash-preview",
    ]);
    expect(config.agents?.defaults?.models?.["openai/gpt-5.3-codex"]).toEqual({ agentRuntime: { id: "codex" } });
    expect(config.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({ agentRuntime: { id: "codex" } });
    expect(config.agents?.defaults?.models?.["openrouter/google/gemini-3-flash-preview"]).toEqual({});
  });

  it("reads all model assignments from config", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-assignments-read-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: "openrouter/google/gemini-2.5-flash",
            fallbacks: ["openrouter/openai/gpt-oss-120b"],
          },
          imageGenerationModel: {
            primary: "openai/gpt-image-2",
            fallbacks: ["openrouter/google/gemini-3.1-flash-image-preview"],
          },
          videoGenerationModel: {
            primary: "fal/fal-ai/minimax/video-01-live",
            fallbacks: ["openai/sora-2"],
          },
        },
      },
    }, null, 2), "utf8");

    const result = await executeAgentControl({
      action: {
        kind: "modelAssignments.read",
      },
      configPath,
      gateway: noopGateway,
    });

    expect(result).toEqual({
      kind: "modelAssignments.read",
      assignments: [
        {
          purpose: "main",
          primary: "openrouter/google/gemini-2.5-flash",
          fallback: "openrouter/openai/gpt-oss-120b",
        },
        {
          purpose: "image",
          primary: null,
          fallback: null,
        },
        {
          purpose: "imageGeneration",
          primary: "openai/gpt-image-2",
          fallback: "openrouter/google/gemini-3.1-flash-image-preview",
        },
        {
          purpose: "videoGeneration",
          primary: "fal/fal-ai/minimax/video-01-live",
          fallback: "openai/sora-2",
        },
        {
          purpose: "musicGeneration",
          primary: null,
          fallback: null,
        },
        {
          purpose: "pdf",
          primary: null,
          fallback: null,
        },
      ],
    });
  });

  it("writes a non-main model assignment and registers both refs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-assignment-set-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await installFakeSystemctl();
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");

    const result = await executeAgentControl({
      action: {
        kind: "modelAssignment.set",
        purpose: "videoGeneration",
        primary: "fal/fal-ai/minimax/video-01-live",
        fallback: "openai/sora-2",
        contextTokens: null,
        thinkingDefault: null,
      },
      configPath,
      gateway: noopGateway,
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: {
        defaults?: {
          videoGenerationModel?: { primary?: string; fallbacks?: string[] };
          models?: Record<string, unknown>;
          thinkingDefault?: string;
        };
      };
    };

    expect(result).toMatchObject({
      kind: "modelAssignment.set",
      purpose: "videoGeneration",
      primary: "fal/fal-ai/minimax/video-01-live",
      fallback: "openai/sora-2",
      thinkingDefault: null,
    });
    expect(config.agents?.defaults?.videoGenerationModel?.primary).toBe("fal/fal-ai/minimax/video-01-live");
    expect(config.agents?.defaults?.videoGenerationModel?.fallbacks).toEqual(["openai/sora-2"]);
    expect(config.agents?.defaults?.models?.["fal/fal-ai/minimax/video-01-live"]).toEqual({});
    expect(config.agents?.defaults?.models?.["openai/sora-2"]).toEqual({});
    expect(config.agents?.defaults?.thinkingDefault).toBeUndefined();
  });

  it("keeps public codex refs for model assignments when a Codex OAuth login is saved", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-model-assignment-codex-oauth-"));
    const configPath = path.join(tempDir, "openclaw.json");
    await installFakeSystemctl();
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");
    await fs.writeFile(
      path.join(tempDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:user@example.com": {
              type: "oauth",
              provider: "openai-codex",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              email: "user@example.com",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await executeAgentControl({
      action: {
        kind: "modelAssignment.set",
        purpose: "main",
        primary: "codex/gpt-5.5",
        fallback: "codex/gpt-5.4",
        contextTokens: 400000,
        thinkingDefault: "medium",
      },
      configPath,
      gateway: noopGateway,
    });

    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      agents?: {
        defaults?: {
          model?: { primary?: string; fallbacks?: string[] };
          models?: Record<string, unknown>;
        };
      };
    };

    expect(result).toMatchObject({
      kind: "modelAssignment.set",
      purpose: "main",
      primary: "codex/gpt-5.5",
      fallback: "codex/gpt-5.4",
      contextTokens: 400000,
      thinkingDefault: "medium",
    });
    expect(config.agents?.defaults?.model?.primary).toBe("openai/gpt-5.5");
    expect(config.agents?.defaults?.model?.fallbacks).toEqual(["openai/gpt-5.4"]);
    expect(config.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({ agentRuntime: { id: "codex" } });
    expect(config.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({ agentRuntime: { id: "codex" } });
  });
});
