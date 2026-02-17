import { GatewayClient } from "./gatewayClient.js";
import { type ChatEvent, chatEventSchema, type EventFrame } from "./protocol.js";

export type ChatRunResult =
  | { outcome: "reply"; reply: { message: unknown; runId: string } }
  | { outcome: "no_reply"; noReply?: { reason?: string; runId: string } }
  | { outcome: "error"; error: { code: string; message: string; runId?: string } };

type Waiter = {
  resolve: (evt: ChatEvent) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

export class ChatRunner {
  private waitersByRunId = new Map<string, Waiter>();

  constructor(private readonly gateway: GatewayClient) {}

  handleEvent(evt: EventFrame): void {
    if (evt.event !== "chat") return;
    const parsed = chatEventSchema.safeParse(evt.payload);
    if (!parsed.success) return;
    const chatEvt = parsed.data;
    if (chatEvt.state !== "final" && chatEvt.state !== "error" && chatEvt.state !== "aborted") {
      return;
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
      return {
        result: { outcome: "error", error: { code: "NO_RUN_ID", message: "Gateway did not return runId" } },
        openclawMeta: { method: "chat.send" },
      };
    }

    try {
      const finalEvt = await this.waitForFinal(runId, input.timeoutMs);
      if (finalEvt.state === "final") {
        if (finalEvt.message !== undefined) {
          return {
            result: { outcome: "reply", reply: { message: finalEvt.message, runId } },
            openclawMeta: { method: "chat.send", runId },
          };
        }
        return {
          result: { outcome: "no_reply", noReply: { runId } },
          openclawMeta: { method: "chat.send", runId },
        };
      }
      if (finalEvt.state === "aborted") {
        return {
          result: { outcome: "error", error: { code: "ABORTED", message: "Chat aborted", runId } },
          openclawMeta: { method: "chat.send", runId },
        };
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
        await this.gateway.request("chat.abort", { sessionKey: input.sessionKey, runId });
      } catch {
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

