import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";
import { logger } from "../logger.js";

export type ChatRunResult =
  | { outcome: "reply"; reply: { message: unknown; runId: string } }
  | { outcome: "no_reply"; noReply?: { reason?: string; runId: string } }
  | { outcome: "error"; error: { code: string; message: string; runId?: string } };

type Waiter = {
  resolve: (evt: ChatEvent) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function makeTextPreview(text: string, maxLen: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  const n = Math.max(0, Math.min(5000, Math.trunc(maxLen)));
  if (n === 0 || normalized.length === 0) return "";
  if (normalized.length <= n) return normalized;
  return `${normalized.slice(0, n)}...`;
}

export class ChatRunner {
  private waitersByRunId = new Map<string, Waiter>();
  private readonly devLogEnabled: boolean;
  private readonly devLogTextMaxLen: number;

  constructor(
    private readonly gateway: GatewayClient,
    opts?: { devLogEnabled?: boolean; devLogTextMaxLen?: number }
  ) {
    this.devLogEnabled = opts?.devLogEnabled ?? false;
    this.devLogTextMaxLen = opts?.devLogTextMaxLen ?? 200;
  }

  handleEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvt = parsed.data;
    if (chatEvt.state !== "final" && chatEvt.state !== "error" && chatEvt.state !== "aborted") {
      return;
    }
    if (this.devLogEnabled) {
      logger.debug({ runId: chatEvt.runId, state: chatEvt.state }, "Gateway chat event terminal");
    }
    const waiter = this.waitersByRunId.get(chatEvt.runId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waitersByRunId.delete(chatEvt.runId);
    waiter.resolve(chatEvt);
  }

  async runChatTask(input: {
    taskId: string;
    sessionKey: string;
    messageText: string;
    timeoutMs: number;
  }): Promise<{ result: ChatRunResult; openclawMeta: { method: string; runId?: string } }> {
    if (this.devLogEnabled) {
      logger.debug(
        {
          taskId: input.taskId,
          sessionKey: input.sessionKey,
          timeoutMs: input.timeoutMs,
          messageLen: input.messageText.length,
          messagePreview: makeTextPreview(input.messageText, this.devLogTextMaxLen),
        },
        "Relay starting chat task"
      );
    }

    // `chat.send` is side-effecting; idempotencyKey must be stable across retries.
    const payload = await this.gateway.request("chat.send", {
      sessionKey: input.sessionKey,
      message: input.messageText,
      idempotencyKey: input.taskId,
      timeoutMs: input.timeoutMs,
    });

    // Server will emit chat events keyed by runId.
    const runId = extractRunId(payload);
    if (!runId) {
      if (this.devLogEnabled) {
        logger.warn({ taskId: input.taskId }, "Gateway did not return runId for chat.send");
      }
      return {
        result: { outcome: "error", error: { code: "NO_RUN_ID", message: "Gateway did not return runId" } },
        openclawMeta: { method: "chat.send" },
      };
    }

    try {
      if (this.devLogEnabled) {
        logger.debug({ taskId: input.taskId, runId }, "Relay waiting for chat final event");
      }
      const finalEvt = await this.waitForFinal(runId, input.timeoutMs);
      if (finalEvt.state === "final") {
        if (finalEvt.message !== undefined) {
          if (this.devLogEnabled) {
            logger.debug({ taskId: input.taskId, runId, outcome: "reply" }, "Relay chat task completed");
          }
          return {
            result: { outcome: "reply", reply: { message: finalEvt.message, runId } },
            openclawMeta: { method: "chat.send", runId },
          };
        }
        if (this.devLogEnabled) {
          logger.debug({ taskId: input.taskId, runId, outcome: "no_reply" }, "Relay chat task completed");
        }
        return {
          result: { outcome: "no_reply", noReply: { runId } },
          openclawMeta: { method: "chat.send", runId },
        };
      }
      if (finalEvt.state === "aborted") {
        if (this.devLogEnabled) {
          logger.warn({ taskId: input.taskId, runId }, "Relay chat aborted");
        }
        return {
          result: { outcome: "error", error: { code: "ABORTED", message: "Chat aborted", runId } },
          openclawMeta: { method: "chat.send", runId },
        };
      }
      if (this.devLogEnabled) {
        logger.warn({ taskId: input.taskId, runId, errorMessage: finalEvt.errorMessage ?? null }, "Relay chat gateway error");
      }
      return {
        result: {
          outcome: "error",
          error: { code: "GATEWAY_ERROR", message: finalEvt.errorMessage ?? "Chat error", runId },
        },
        openclawMeta: { method: "chat.send", runId },
      };
    } catch (err) {
      // Best-effort abort.
      try {
        if (this.devLogEnabled) {
          logger.warn(
            { taskId: input.taskId, runId, err: err instanceof Error ? err.message : String(err) },
            "Relay timed out waiting for chat final; aborting"
          );
        }
        await this.gateway.request("chat.abort", { sessionKey: input.sessionKey, runId });
      } catch {
        if (this.devLogEnabled) {
          logger.warn({ taskId: input.taskId, runId }, "Relay failed to abort chat after timeout");
        }
        // ignore
      }
      return {
        result: {
          outcome: "error",
          error: {
            code: "GATEWAY_TIMEOUT",
            message: err instanceof Error ? err.message : "Timed out waiting for final",
            runId,
          },
        },
        openclawMeta: { method: "chat.send", runId },
      };
    }
  }

  private waitForFinal(runId: string, timeoutMs: number): Promise<ChatEvent> {
    return new Promise<ChatEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waitersByRunId.delete(runId);
        reject(new Error("Timed out waiting for final"));
      }, timeoutMs);
      this.waitersByRunId.set(runId, { resolve, reject, timeout });
    });
  }
}

function extractRunId(payload: unknown): string | null {
  // OpenClaw chat.send typically returns { runId, ... }.
  if (!payload || typeof payload !== "object") return null;
  const runId = (payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

