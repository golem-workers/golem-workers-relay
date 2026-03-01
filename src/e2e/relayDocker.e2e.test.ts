import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

type MockBackend = {
  baseUrl: string;
  close: () => Promise<void>;
  waitForCallback: (timeoutMs: number) => Promise<{ body: unknown; headers: http.IncomingHttpHeaders }>;
};

let lastPairingAttempt: { status: number | null; stdout: string; stderr: string } | null = null;

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version"], { stdio: "ignore" });
  return r.status === 0;
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to determine free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  let delayMs = 250;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await fn()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(2000, Math.floor(delayMs * 1.3));
  }
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  await waitFor(
    async () =>
      await new Promise<boolean>((resolve) => {
        const s = net.createConnection({ host, port });
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
        s.setTimeout(1000, () => {
          s.destroy();
          resolve(false);
        });
      }),
    timeoutMs,
    `tcp ${host}:${port} to accept connections`
  );
}

async function startMockBackend(opts: { relayToken: string }): Promise<MockBackend> {
  const port = await getFreePort();
  let resolveResult: ((v: { body: unknown; headers: http.IncomingHttpHeaders }) => void) | null = null;
  const resultPromise = new Promise<{ body: unknown; headers: http.IncomingHttpHeaders }>((r) => {
    resolveResult = r;
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "METHOD_NOT_ALLOWED", message: "method not allowed" }));
        return;
      }

      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.relayToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "bad token" }));
        return;
      }

      const body = await readJson(req);

      if (url.pathname === "/api/v1/relays/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
        resolveResult?.({ body, headers: req.headers });
        resolveResult = null;
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND", message: "not found" }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) }));
    }
  };

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    waitForCallback: async (timeoutMs: number) => {
      const timer = setTimeout(() => {
        // Force a clear error; promise will stay pending otherwise.
        resolveResult?.({ body: { timeout: true }, headers: {} });
        resolveResult = null;
      }, timeoutMs);
      try {
        const r = await resultPromise;
        if ((r.body as { timeout?: boolean })?.timeout) {
          throw new Error("Timed out waiting for relay callback");
        }
        return r;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      // Shouldn't happen, but keep parsing robust.
      chunks.push(Buffer.from(String(chunk), "utf8"));
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as unknown) : null;
}

async function postRelayPush(input: {
  baseUrl: string;
  relayToken: string;
  body: unknown;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const resp = await fetch(`${input.baseUrl}/relay/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.relayToken}`,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Relay push failed with status ${resp.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function spawnRelay(opts: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): { proc: ChildProcessWithoutNullStreams; getLogs: () => { stdout: string; stderr: string } } {
  const tsxPath = path.join(opts.cwd, "node_modules", ".bin", "tsx");
  // Helpful failure message if `npm ci` wasn't run.
  try {
    if (spawnSync(tsxPath, ["--version"], { stdio: "ignore" }).status !== 0) {
      throw new Error("tsx returned non-zero");
    }
  } catch {
    throw new Error("tsx binary not found; run npm ci in golem-workers-relay before e2e");
  }
  const child = spawn(tsxPath, ["src/index.ts"], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: "pipe",
  });
  // Keep logs for debugging; do not print by default.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const cap = (arr: string[]) => {
    while (arr.length > 400) arr.shift();
  };
  child.stdout.on("data", (d: string) => {
    stdoutChunks.push(d);
    cap(stdoutChunks);
  });
  child.stderr.on("data", (d: string) => {
    stderrChunks.push(d);
    cap(stderrChunks);
  });

  return {
    proc: child,
    getLogs: () => ({ stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") }),
  };
}

function dockerComposeBaseArgs(opts: {
  cwd: string;
  projectName: string;
  envFilePath: string;
}): string[] {
  return [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.e2e.yml",
    "--env-file",
    opts.envFilePath,
    "-p",
    opts.projectName,
  ];
}

function runDockerCompose(
  opts: { cwd: string; projectName: string; envFilePath: string },
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", [...dockerComposeBaseArgs(opts), ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runDockerComposeAsync(
  opts: { cwd: string; projectName: string; envFilePath: string },
  args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", [...dockerComposeBaseArgs(opts), ...args], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
    child.on("error", () => resolve({ status: 1, stdout, stderr }));
  });
}

async function tryApprovePairing(opts: {
  cwd: string;
  projectName: string;
  envFilePath: string;
  token: string;
}): Promise<void> {
  // Best effort: might fail when there is no pending request yet.
  // We retry for a while while relay is connecting.
  for (let i = 0; i < 60; i += 1) {
    const listed = await runDockerComposeAsync(opts, [
      "exec",
      "-T",
      "openclaw-gateway",
      "openclaw",
      "devices",
      "list",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      opts.token,
      "--json",
    ]);
    lastPairingAttempt = listed;
    if (listed.status === 0) {
      try {
        const parsed = JSON.parse(listed.stdout) as unknown;
        const pending = (parsed as { pending?: unknown }).pending;
        const pendingArr = Array.isArray(pending) ? (pending as unknown[]) : [];
        const first: unknown = pendingArr.length > 0 ? pendingArr[0] : null;
        const requestId =
          first && typeof first === "object" ? (first as Record<string, unknown>).requestId ?? null : null;
        if (typeof requestId === "string" && requestId) {
          const approved = await runDockerComposeAsync(opts, [
            "exec",
            "-T",
            "openclaw-gateway",
            "openclaw",
            "devices",
            "approve",
            requestId,
            "--url",
            "ws://127.0.0.1:18789",
            "--token",
            opts.token,
            "--json",
          ]);
          lastPairingAttempt = approved;
          if (approved.status === 0) return;
        }
      } catch {
        // ignore parse errors; retry
      }
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
}

const hasDocker = dockerAvailable();
const testIt = hasDocker ? it : it.skip;

describe("e2e: relay works against OpenClaw gateway (docker)", () => {
  testIt(
    "accepts push message and submits callback result",
    { timeout: 240_000 },
    async () => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const repoRoot = path.resolve(here, "..", "..");
      const projectName = `gw-relay-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gw-relay-e2e-"));
      const relayStateDir = path.join(tmpDir, "relay-state");
      const envFilePath = path.join(tmpDir, "openclaw.e2e.env");

      const gatewayPort = await getFreePort();
      let bridgePort = await getFreePort();
      while (bridgePort === gatewayPort) bridgePort = await getFreePort();
      const gatewayToken = `e2e-token-${randomUUID()}`;
      const relayPushPort = await getFreePort();

      // Compose requires OPENROUTER_API_KEY; gateway can start unconfigured.
      await writeFile(
        envFilePath,
        [
          `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
          `OPENROUTER_API_KEY=dummy`,
          `OPENCLAW_GATEWAY_PORT=${gatewayPort}`,
          `OPENCLAW_BRIDGE_PORT=${bridgePort}`,
          `OPENCLAW_GATEWAY_BIND=lan`,
          `OPENCLAW_SKIP_CHANNELS=1`,
        ].join("\n") + "\n",
        "utf8"
      );

      const backend = await startMockBackend({ relayToken: "test-relay-token" });
      let relay: ChildProcessWithoutNullStreams | null = null;
      let getRelayLogs: (() => { stdout: string; stderr: string }) | null = null;

      try {
        const up = runDockerCompose({ cwd: repoRoot, projectName, envFilePath }, [
          "up",
          "-d",
          "--build",
          "openclaw-gateway",
        ]);
        if (up.status !== 0) {
          throw new Error(`docker compose up failed: ${up.stderr || up.stdout}`);
        }

        await waitForTcpPort("127.0.0.1", gatewayPort, 60_000);

        // Start relay on host.
        const spawned = spawnRelay({
          cwd: repoRoot,
          env: {
            ...process.env,
            BACKEND_BASE_URL: backend.baseUrl,
            RELAY_TOKEN: "test-relay-token",
            RELAY_PUSH_PORT: String(relayPushPort),
            RELAY_CONCURRENCY: "1",
            RELAY_TASK_TIMEOUT_MS: "15000",
            OPENCLAW_GATEWAY_WS_URL: `ws://127.0.0.1:${gatewayPort}`,
            OPENCLAW_GATEWAY_TOKEN: gatewayToken,
            OPENCLAW_STATE_DIR: relayStateDir,
            LOG_LEVEL: "info",
          },
        });
        relay = spawned.proc;
        getRelayLogs = spawned.getLogs;

        // Best-effort pairing auto-approve (if the gateway requests it).
        // Do not fail the test if approval doesn't succeed; we still might connect without it.
        void tryApprovePairing({ cwd: repoRoot, projectName, envFilePath, token: gatewayToken });

        const debugDump = (reason: string) => {
          const logs = getRelayLogs?.() ?? { stdout: "", stderr: "" };
          const gwLogs = runDockerCompose({ cwd: repoRoot, projectName, envFilePath }, [
            "logs",
            "--no-color",
            "--tail",
            "200",
            "openclaw-gateway",
          ]);
          const devicesList = runDockerCompose({ cwd: repoRoot, projectName, envFilePath }, [
            "exec",
            "-T",
            "openclaw-gateway",
            "openclaw",
            "devices",
            "list",
            "--url",
            "ws://127.0.0.1:18789",
            "--token",
            gatewayToken,
            "--json",
          ]);
          const pairing = lastPairingAttempt
            ? [
                `status=${String(lastPairingAttempt.status)}`,
                lastPairingAttempt.stdout.trim(),
                lastPairingAttempt.stderr.trim(),
              ]
                .filter(Boolean)
                .join("\n")
            : "(no attempts recorded)";
          return [
            reason,
            "",
            "---- relay stdout ----",
            logs.stdout.trim() || "(empty)",
            "",
            "---- relay stderr ----",
            logs.stderr.trim() || "(empty)",
            "",
            "---- openclaw devices list (json) ----",
            (devicesList.stdout || devicesList.stderr).trim() || "(empty)",
            "",
            "---- last pairing approve attempt ----",
            pairing,
            "",
            "---- openclaw-gateway logs ----",
            (gwLogs.stdout || gwLogs.stderr).trim() || "(empty)",
          ].join("\n");
        };

        await waitForTcpPort("127.0.0.1", relayPushPort, 60_000);

        let body: unknown;
        try {
          await postRelayPush({
            baseUrl: `http://127.0.0.1:${relayPushPort}`,
            relayToken: "test-relay-token",
            body: {
              messageId: `msg_${randomUUID()}`,
              sentAtMs: Date.now(),
              input: { kind: "chat", sessionKey: "e2e:s1", messageText: "ping" },
            },
            timeoutMs: 15_000,
          });
          ({ body } = await backend.waitForCallback(60_000));
        } catch (err) {
          throw new Error(debugDump(err instanceof Error ? err.message : String(err)));
        }

        expect(body).toBeTruthy();
        expect(typeof body).toBe("object");

        const b = body as Record<string, unknown>;
        expect(typeof b.relayInstanceId).toBe("string");
        expect((b.relayInstanceId as string).length).toBeGreaterThan(0);
        expect(["reply", "no_reply", "error"]).toContain(b.outcome);
      } finally {
        const proc = relay;
        if (proc) {
          proc.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              try {
                proc.kill("SIGKILL");
              } catch {
                // ignore
              }
              resolve();
            }, 5000);
            proc.once("exit", () => {
              clearTimeout(t);
              resolve();
            });
          });
        }

        await backend.close();

        // Always attempt to tear down compose project + volumes.
        runDockerCompose({ cwd: repoRoot, projectName, envFilePath }, [
          "down",
          "--remove-orphans",
          "--volumes",
        ]);

        await rm(tmpDir, { recursive: true, force: true });
      }
    }
  );
});

