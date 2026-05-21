import { describe, expect, it, vi } from "vitest";
import { abortActiveChatTaskByBackendMessageId } from "./abortActiveChatTask.js";
import { createRelayTaskControl } from "../processor/messageProcessor.js";

describe("abortActiveChatTaskByBackendMessageId", () => {
  it("aborts the matching active task and calls runner.abortTask", async () => {
    const taskControl = createRelayTaskControl();
    const abort = vi.fn();
    taskControl.register({
      messageId: "backend_1",
      sessionKey: "s1",
      taskKind: "user_chat",
      startedAtMs: Date.now(),
      abort,
    });
    const abortTask = vi.fn().mockResolvedValue(true);

    const result = await abortActiveChatTaskByBackendMessageId({
      taskControl,
      runner: { abortTask },
      backendMessageId: "backend_1",
      reason: "backend_abort",
    });

    expect(result).toEqual({ aborted: true });
    expect(abort).toHaveBeenCalledWith("backend_abort");
    expect(abortTask).toHaveBeenCalledWith("backend_1", "backend_abort");
  });

  it("returns aborted false when no active task matches", async () => {
    const taskControl = createRelayTaskControl();
    const abortTask = vi.fn().mockResolvedValue(true);

    const result = await abortActiveChatTaskByBackendMessageId({
      taskControl,
      runner: { abortTask },
      backendMessageId: "missing",
      reason: "backend_abort",
    });

    expect(result).toEqual({ aborted: false });
    expect(abortTask).not.toHaveBeenCalled();
  });
});
