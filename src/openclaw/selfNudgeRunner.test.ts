import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeSelfNudgeWaitMs,
  evaluateSelfNudgeTick,
  formatStatusNudgeMessage,
  readFreshestSessionTranscript,
  readRelayChannelNudgeSettings,
  type FreshestSessionTranscript,
  type RelayChannelNudgeSettings,
  type SelfNudgeState,
} from "./selfNudgeRunner.js";

const enabledSettings: RelayChannelNudgeSettings = {
  enabled: true,
  analyzedRecentMessageCount: 1,
  baseTimeoutMs: 1_000,
  model: "openrouter/google/gemini-test",
};

function makeState(): SelfNudgeState {
  return {
    sessionKey: null,
    latestUserFingerprint: null,
    consecutiveNudges: 0,
    lastNudgeAtMs: null,
  };
}

function makeTranscript(input?: Partial<FreshestSessionTranscript>): FreshestSessionTranscript {
  return {
    sessionKey: "s1",
    sessionFile: "/tmp/s1.jsonl",
    mtimeMs: 10_000,
    messages: [{ role: "user", text: "please finish this task", lineIndex: 0 }],
    latestUserMessage: { role: "user", text: "please finish this task", lineIndex: 0 },
    ...input,
  };
}

describe("selfNudgeRunner", () => {
  it("reads relay-channel nudge settings from OpenClaw config", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-config-"));
    const file = path.join(dir, "openclaw.json");
    await fs.writeFile(
      file,
      JSON.stringify({
        channels: {
          "relay-channel": {
            nudge: {
              enabled: true,
              analyzedRecentMessageCount: 3,
              baseTimeoutMs: 12_000,
              model: "openrouter/google/gemini-2.5-flash",
            },
          },
        },
      }),
      "utf8"
    );

    await expect(readRelayChannelNudgeSettings(file)).resolves.toEqual({
      enabled: true,
      analyzedRecentMessageCount: 3,
      baseTimeoutMs: 12_000,
      model: "openrouter/google/gemini-2.5-flash",
    });
  });

  it("selects the freshest OpenClaw session transcript and returns the latest 1 + N messages", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const oldSessionFile = path.join(sessionsDir, "old.jsonl");
    const freshSessionFile = path.join(sessionsDir, "fresh.jsonl");
    await fs.writeFile(oldSessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: "old" } })}\n`);
    await fs.writeFile(
      freshSessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "working" }] } }),
        JSON.stringify({ type: "message", message: { role: "user", content: "latest" } }),
      ].join("\n")
    );
    await fs.utimes(oldSessionFile, new Date(1_000), new Date(1_000));
    await fs.utimes(freshSessionFile, new Date(2_000), new Date(2_000));
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:old": { sessionFile: oldSessionFile },
        "agent:main:fresh": { sessionFile: "fresh.jsonl" },
      }),
      "utf8"
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("fresh");
    expect(transcript?.messages).toEqual([
      { role: "assistant", text: "working", lineIndex: 1 },
      { role: "user", text: "latest", lineIndex: 2 },
    ]);
    expect(transcript?.latestUserMessage).toEqual({ role: "user", text: "latest", lineIndex: 2 });
  });

  it("waits for T * (X + 1), sends a marked self-nudge, then increases backoff", async () => {
    const runChatTask = vi.fn().mockResolvedValue({
      result: { outcome: "no_reply", noReply: { runId: "run_1" } },
      openclawMeta: { method: "chat.send" },
    });
    const state = makeState();

    const early = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 10_500,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn(),
    });
    expect(early).toEqual({ nudged: false, nextDelayMs: 500 });
    expect(runChatTask).not.toHaveBeenCalled();

    const sent = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 11_000,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue with the migration and report the next concrete step.",
      }),
    });

    expect(sent).toEqual({ nudged: true, nextDelayMs: 2_000 });
    expect(runChatTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "s1",
        deliverySystem: "relay_channel_v2",
        timeoutMs: 60_000,
        messageText: "[STATUS_NUDGE]\nContinue with the migration and report the next concrete step.",
      })
    );
    expect(computeSelfNudgeWaitMs(1_000, state.consecutiveNudges)).toBe(2_000);
  });

  it("resets consecutive nudge backoff when a new user message appears", async () => {
    const runChatTask = vi.fn().mockResolvedValue({
      result: { outcome: "no_reply", noReply: { runId: "run_1" } },
      openclawMeta: { method: "chat.send" },
    });
    const state = makeState();
    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 11_000,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue.",
      }),
    });
    expect(state.consecutiveNudges).toBe(1);

    const next = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        mtimeMs: 20_000,
        messages: [{ role: "user", text: "new request", lineIndex: 1 }],
        latestUserMessage: { role: "user", text: "new request", lineIndex: 1 },
      }),
      state,
      nowMs: 20_500,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn(),
    });

    expect(next).toEqual({ nudged: false, nextDelayMs: 500 });
    expect(state.consecutiveNudges).toBe(0);
  });

  it("does nothing when the model decides no nudge is needed", async () => {
    const runChatTask = vi.fn();
    const state = makeState();

    const result = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          { role: "user", text: "please do x", lineIndex: 0 },
          { role: "assistant", text: "Done.", lineIndex: 1 },
        ],
      }),
      state,
      nowMs: 11_000,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn().mockResolvedValue({ shouldNudge: false, statusNudgeMessage: null }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(runChatTask).not.toHaveBeenCalled();
  });

  it("does not double-prefix status nudge messages", () => {
    expect(formatStatusNudgeMessage("[STATUS_NUDGE]\nContinue.")).toBe("[STATUS_NUDGE]\nContinue.");
  });
});
