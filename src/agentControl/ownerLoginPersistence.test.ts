import { writeOwnerFencedConfig } from "./ownerFence.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as codexLoginTesting } from "./codexLogin.js";
import { __testing as githubAuthTesting } from "./githubAuth.js";
import { executeAgentControl } from "./executeAgentControl.js";

vi.mock("./runtimeAuthWriter.js", async () => ({
  writeRuntimeAuth: (await import("./__tests__/runtimeAuthWriter.fixture.js")).legacyRuntimeAuthWriter,
}));

const noopGateway = {
  request: () => {
    throw new Error("gateway should not be called");
  },
};

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalRelayEnvPath = process.env.RELAY_ENV_PATH;
const originalGatewayUnitPath = process.env.OPENCLAW_GATEWAY_UNIT_PATH;
const originalGatewayDropInDir = process.env.OPENCLAW_GATEWAY_DROP_IN_DIR;
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
  if (originalGatewayUnitPath === undefined) delete process.env.OPENCLAW_GATEWAY_UNIT_PATH;
  else process.env.OPENCLAW_GATEWAY_UNIT_PATH = originalGatewayUnitPath;
  if (originalGatewayDropInDir === undefined) delete process.env.OPENCLAW_GATEWAY_DROP_IN_DIR;
  else process.env.OPENCLAW_GATEWAY_DROP_IN_DIR = originalGatewayDropInDir;
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  }
  global.fetch = originalFetch;
  vi.useRealTimers();
});

beforeEach(() => {
  vi.restoreAllMocks();
  codexLoginTesting.resetCodexLoginState();
  githubAuthTesting.resetGitHubOauthState();
});

async function installFakeSystemctl() {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-systemctl-"));
  const scriptPath = path.join(binDir, "systemctl");
  const logPath = path.join(binDir, "calls.log");
  process.env.OPENCLAW_GATEWAY_UNIT_PATH = path.join(binDir, "gateway.service");
  process.env.OPENCLAW_GATEWAY_DROP_IN_DIR = path.join(binDir, "gateway.service.d");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$#" -ge 3 ] && [ "$1" = "--user" ] && [ "$2" = "stop" ] && [ "$3" = "openclaw-gateway.service" ]; then
  exit 0
fi
if [ "$#" -ge 3 ] && [ "$1" = "--user" ] && [ "$2" = "restart" ] && [ "$3" = "openclaw-gateway.service" ]; then
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = "--user" ] && [ "$2" = "daemon-reload" ]; then
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
    "utf8",
  );
  fsSync.chmodSync(scriptPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return logPath;
}

describe("owner-aware asynchronous login persistence", () => {
  it.each([false, true])("async login persistence serializes revoke and safely rolls back failure=%s", async fail => {
    await installFakeSystemctl();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-codex-login-success-"));
    const configPath = path.join(tempDir, "openclaw.json");
    const codexHome = path.join(tempDir, ".codex");
    process.env.CODEX_HOME = codexHome;
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: {} } }, null, 2), "utf8");

    await writeOwnerFencedConfig(configPath, JSON.stringify({ commands: { ownerAllowFrom: ["telegram:123", "discord:123"] }, agents: { defaults: {} } }), { revision: "1", active: ["123"], revoked: [] });
    let release!: () => void, reached!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    let armed = false, intercepted = false;
    const originalRead = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (armed && !intercepted && args[0] === configPath) { intercepted = true; reached(); await barrier; }
      return originalRead(...args);
    });
    const originalRename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (fail && armed && !failed && String(to) === configPath) { failed = true; throw new Error("synthetic persistence failure"); }
      return originalRename(from, to);
    });
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
        armed = true;
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

    const startPromise = executeAgentControl({
      action: { kind: "codex.login.start" },
      configPath,
      gateway: noopGateway,
    });


    await paused;
    let revoked = false;
    const revoke = executeAgentControl({ action: { kind: "config.apply", configText: JSON.stringify({ commands: { ownerAllowFrom: ["telegram:123", "discord:123"] } }), ownerFence: { revision: "2", active: [], revoked: ["123"] } }, configPath, gateway: noopGateway }).then(() => { revoked = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(revoked).toBe(false);
    release();
    expect((await startPromise).kind).toBe("codex.login.start");
    await revoke;
    let statusResult = await executeAgentControl({ action: { kind: "codex.login.status" }, configPath, gateway: noopGateway });
    for (let i = 0; i < 100 && statusResult.state === "pending"; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      statusResult = await executeAgentControl({ action: { kind: "codex.login.status" }, configPath, gateway: noopGateway });
    }
    expect(statusResult.state).toBe(fail ? "failed" : "connected");
    const final = JSON.parse(await originalRead(configPath, "utf8")) as { commands: { ownerAllowFrom: string[] } };
    expect(final.commands.ownerAllowFrom).toEqual(["discord:123"]);
    expect(JSON.parse(await originalRead(configPath + ".owner-fence.json", "utf8"))).toMatchObject({ revision: "2", revoked: ["123"] });
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

});
