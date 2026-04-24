import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentControl } from "./executeAgentControl.js";

const noopGateway = {
  request: () => {
    throw new Error("gateway should not be called");
  },
};

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalPath = process.env.PATH;

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

async function installFakeOpenclaw(output: string) {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-openclaw-"));
  const scriptPath = path.join(binDir, "openclaw");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -eu
if [ "$#" -ge 3 ] && [ "$1" = "channels" ] && [ "$2" = "status" ] && [ "$3" = "--json" ]; then
  cat <<'EOF'
${output}
EOF
  exit 0
fi
exit 1
`,
    "utf8"
  );
  fsSync.chmodSync(scriptPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
}

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

describe("executeAgentControl channels status", () => {
  it("reads OpenClaw channel runtime snapshot from CLI JSON output", async () => {
    await installFakeOpenclaw(`noise before json
{"channels":{"telegram":{"configured":true}},"channelAccounts":{"telegram":[{"accountId":"mybot","connected":true}]}}`);

    const result = await executeAgentControl({
      action: { kind: "channels.status" },
      configPath: "/tmp/openclaw.json",
      gateway: noopGateway,
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
});
