import type { ChatRunner } from "../openclaw/chatRunner.js";
import type { RelayTaskControl } from "../processor/messageProcessor.js";

export async function abortActiveChatTaskByBackendMessageId(input: {
  taskControl: RelayTaskControl;
  runner: Pick<ChatRunner, "abortTask">;
  backendMessageId: string;
  reason: string;
}): Promise<{ aborted: boolean }> {
  const aborted = input.taskControl.abortActive(
    (task) => task.messageId === input.backendMessageId,
    input.reason
  );
  if (aborted && typeof input.runner.abortTask === "function") {
    await input.runner.abortTask(input.backendMessageId, input.reason).catch(() => undefined);
  }
  return { aborted };
}
