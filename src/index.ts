import "dotenv/config";
import { logger } from "./logger.js";
import { loadRelayConfig } from "./config/env.js";
import { resolveOpenclawConfig } from "./openclaw/openclawConfig.js";
import { BackendClient } from "./backend/backendClient.js";
import { GatewayClient } from "./openclaw/gatewayClient.js";
import { ChatRunner } from "./openclaw/chatRunner.js";

function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

async function main(): Promise<void> {
  const cfg = loadRelayConfig(process.env);
  const openclaw = resolveOpenclawConfig(process.env, {
    gatewayWsUrl: cfg.openclaw.gatewayWsUrl,
  });
  logger.info(
    {
      pid: process.pid,
      relayInstanceId: cfg.relayInstanceId,
      backendBaseUrl: cfg.backendBaseUrl,
      gatewayWsUrl: openclaw.gateway.wsUrl,
      openclawConfigPath: openclaw.configPath,
      maxTasks: cfg.maxTasks,
      waitSeconds: cfg.waitSeconds,
      concurrency: cfg.concurrency,
    },
    "Relay starting"
  );

  const backend = new BackendClient({
    baseUrl: cfg.backendBaseUrl,
    relayToken: cfg.relayToken,
    devLogEnabled: cfg.devLogEnabled,
  });

  let chatRunner: ChatRunner | null = null;
  const gateway = new GatewayClient({
    url: openclaw.gateway.wsUrl,
    token: openclaw.gateway.auth.token,
    password: openclaw.gateway.auth.password,
    instanceId: cfg.relayInstanceId,
    role: "operator",
    scopes: cfg.openclaw.scopes,
    onEvent: (evt) => chatRunner?.handleEvent(evt),
    devLogEnabled: cfg.devLogEnabled,
    devLogTextMaxLen: cfg.devLogTextMaxLen,
    devLogGatewayFrames: cfg.devLogGatewayFrames,
  });
  chatRunner = new ChatRunner(gateway, { devLogEnabled: cfg.devLogEnabled, devLogTextMaxLen: cfg.devLogTextMaxLen });

  const stop = createStopSignal();
  await ensureGatewayConnected(gateway, stop);
  const runner = chatRunner;
  if (!runner) {
    throw new Error("ChatRunner not initialized");
  }

  while (!stop.stopped) {
    let pulled: Awaited<ReturnType<typeof backend.pull>>;
    try {
      pulled = await backend.pull({
        relayInstanceId: cfg.relayInstanceId,
        maxTasks: cfg.maxTasks,
        waitSeconds: cfg.waitSeconds,
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Pull failed; backing off");
      await sleep(1000);
      continue;
    }

    if (cfg.devLogEnabled) {
      logger.debug(
        {
          tasksCount: pulled.tasks.length,
          tasks: pulled.tasks.slice(0, 50).map((t) => ({ taskId: t.taskId, kind: t.input.kind })),
          truncated: pulled.tasks.length > 50,
        },
        "Pulled tasks from backend"
      );
    }

    if (pulled.tasks.length === 0) {
      continue;
    }

    await runWithConcurrency(pulled.tasks, cfg.concurrency, async (t) => {
      const startedAt = Date.now();
      try {
        if (cfg.devLogEnabled) {
          logger.debug(
            {
              taskId: t.taskId,
              attempt: t.attempt,
              leaseId: t.leaseId,
              kind: t.input.kind,
              sessionKey: t.input.kind === "chat" ? t.input.sessionKey : null,
              messageLen: t.input.kind === "chat" ? t.input.messageText.length : null,
              messagePreview:
                t.input.kind === "chat" ? makeTextPreview(t.input.messageText, cfg.devLogTextMaxLen) : null,
              timeoutMs: cfg.taskTimeoutMs,
            },
            "Task started"
          );
        }

        if (t.input.kind === "handshake") {
          // Explicit health/handshake task: ensure we can connect and receive hello-ok.
          await withTimeout(gateway.start(), cfg.taskTimeoutMs, "gateway.start");
          const hello = gateway.getHello();
          if (!hello) {
            throw new Error("Gateway is not ready (missing hello-ok)");
          }

          const reply = {
            nonce: t.input.nonce,
            helloType: hello.type,
            protocol: hello.protocol,
            policy: hello.policy,
            features: hello.features
              ? { methodsCount: hello.features.methods.length, eventsCount: hello.features.events.length }
              : null,
            auth: hello.auth ? { role: hello.auth.role, scopes: hello.auth.scopes } : null,
          };

          const finishedAtMs = Date.now();
          await backend.submitResult({
            taskId: t.taskId,
            body: {
              relayInstanceId: cfg.relayInstanceId,
              attempt: t.attempt,
              leaseId: t.leaseId,
              finishedAtMs,
              outcome: "reply",
              reply,
              openclawMeta: { method: "connect" },
            },
          });
        } else {
          const { result, openclawMeta } = await runner.runChatTask({
            taskId: t.taskId,
            sessionKey: t.input.sessionKey,
            messageText: t.input.messageText,
            timeoutMs: cfg.taskTimeoutMs,
          });

          const finishedAtMs = Date.now();
          if (result.outcome === "reply") {
            await backend.submitResult({
              taskId: t.taskId,
              body: {
                relayInstanceId: cfg.relayInstanceId,
                attempt: t.attempt,
                leaseId: t.leaseId,
                finishedAtMs,
                outcome: "reply",
                reply: normalizeReply(result.reply.message),
                openclawMeta,
              },
            });
          } else if (result.outcome === "no_reply") {
            await backend.submitResult({
              taskId: t.taskId,
              body: {
                relayInstanceId: cfg.relayInstanceId,
                attempt: t.attempt,
                leaseId: t.leaseId,
                finishedAtMs,
                outcome: "no_reply",
                noReply: result.noReply ?? { reason: "no_message" },
                openclawMeta,
              },
            });
          } else {
            await backend.submitResult({
              taskId: t.taskId,
              body: {
                relayInstanceId: cfg.relayInstanceId,
                attempt: t.attempt,
                leaseId: t.leaseId,
                finishedAtMs,
                outcome: "error",
                error: result.error,
                openclawMeta,
              },
            });
          }
        }

        logger.info(
          { taskId: t.taskId, attempt: t.attempt, durationMs: Date.now() - startedAt },
          "Task processed"
        );
      } catch (err) {
        const finishedAtMs = Date.now();
        logger.warn(
          { taskId: t.taskId, attempt: t.attempt, err: err instanceof Error ? err.message : String(err) },
          "Task processing failed"
        );
        try {
          await backend.submitResult({
            taskId: t.taskId,
            body: {
              relayInstanceId: cfg.relayInstanceId,
              attempt: t.attempt,
              leaseId: t.leaseId,
              finishedAtMs,
              outcome: "error",
              error: { code: "RELAY_INTERNAL_ERROR", message: "Relay failed to process task" },
              openclawMeta: { method: "relay" },
            },
          });
        } catch (submitErr) {
          logger.warn(
            { taskId: t.taskId, err: submitErr instanceof Error ? submitErr.message : String(submitErr) },
            "Failed to submit error result"
          );
        }
      }
    });
  }

  gateway.stop();
  logger.info("Relay stopped");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "Relay crashed");
  process.exit(1);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function createStopSignal() {
  const state = { stopped: false };
  const stop = () => {
    state.stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return state;
}

async function ensureGatewayConnected(gateway: GatewayClient, stop: { stopped: boolean }) {
  while (!stop.stopped) {
    try {
      await gateway.start();
      return;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Gateway connect failed; retrying");
      await sleep(1000);
    }
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (concurrency <= 1) {
    for (const item of items) {
      await fn(item);
    }
    return;
  }

  const queue = items.slice();
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await fn(next);
    }
  });
  await Promise.all(workers);
}

function normalizeReply(message: unknown): unknown {
  if (message && typeof message === "object") {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return { text };
    }
  }
  return { message };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.max(1, timeoutMs);
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

