import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFinalDecisionNoticeText,
  buildOpenRouterProxyChatCompletionsUrl,
  computeSelfNudgeWaitMs,
  createFileSelfNudgeProcessedStore,
  createSelfNudgeRunner,
  evaluateSelfNudgeTick,
  formatStatusNudgeMessage,
  readFreshestOpenclawRuntimeTranscript,
  readFreshestSessionTranscript,
  type FreshestSessionTranscript,
  type RelaySelfNudgeSettings,
  type SelfNudgeDecision,
  type SelfNudgeState,
} from "./selfNudgeRunner.js";

const enabledSettings: RelaySelfNudgeSettings = {
  enabled: true,
  analyzedRecentMessageCount: 1,
  baseTimeoutMs: 1_000,
  model: "openrouter/google/gemini-test",
  finalNoticeEnabled: false,
  finalNoticeText: "Final message.",
};

type FinalDecisionNotice = {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  nowMs: number;
};

function makeState(): SelfNudgeState {
  return {
    sessionKey: null,
    latestUserFingerprint: null,
    consecutiveNudges: 0,
    lastNudgeAtMs: null,
    lastFinalNoticeFingerprint: null,
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
  it("uses relay env-backed self-nudge settings passed at startup", async () => {
    const runner = createSelfNudgeRunner({
      settings: {
        enabled: false,
        analyzedRecentMessageCount: 3,
        baseTimeoutMs: 12_000,
        model: "openrouter/google/gemini-2.5-flash",
      },
      stateDir: await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-state-")),
      runner: { runChatTask: vi.fn() },
      openrouterProxyPort: 18080,
      openrouterProxyPathPrefix: "/provider-proxy/openrouter",
      systemTaskTimeoutMs: 1_000,
      pollIntervalMs: 1_000,
    });

    await expect(runner.tick()).resolves.toBeUndefined();
  });

  it("selects the OpenClaw session with the newest user message and returns the latest 1 + N messages", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const completedSessionFile = path.join(sessionsDir, "completed.jsonl");
    const activeSessionFile = path.join(sessionsDir, "active.jsonl");
    await fs.writeFile(
      completedSessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", timestamp: 1_000, content: "older request" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 1_100, content: "Done." } }),
      ].join("\n")
    );
    await fs.writeFile(
      activeSessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", timestamp: 4_000, content: "first" } }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", timestamp: 4_100, content: [{ type: "text", text: "working" }] },
        }),
        JSON.stringify({ type: "message", message: { role: "user", timestamp: 4_200, content: "latest" } }),
      ].join("\n")
    );
    await fs.utimes(completedSessionFile, new Date(5_000), new Date(5_000));
    await fs.utimes(activeSessionFile, new Date(2_000), new Date(2_000));
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:completed": { sessionFile: completedSessionFile },
        "agent:main:active": { sessionFile: "active.jsonl" },
      }),
      "utf8"
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("active");
    expect(transcript?.messages).toEqual([
      { role: "assistant", text: "working", lineIndex: 1, timestampMs: 4_100 },
      { role: "user", text: "latest", lineIndex: 2, timestampMs: 4_200 },
    ]);
    expect(transcript?.latestUserMessage).toEqual({ role: "user", text: "latest", lineIndex: 2, timestampMs: 4_200 });
  });

  it("ignores internal maintenance sessions when choosing a nudge transcript", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-state-"));
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const heartbeatSessionFile = path.join(sessionsDir, "main.jsonl");
    const workSessionFile = path.join(sessionsDir, "work.jsonl");
    await fs.writeFile(
      heartbeatSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 5_000,
            content: "Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK.",
          },
        }),
        JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 5_100, content: "HEARTBEAT_OK" } }),
      ].join("\n")
    );
    await fs.writeFile(
      workSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", timestamp: 4_000, content: "Complete the runtime scenario checks." },
        }),
        JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 4_100, content: "Working." } }),
      ].join("\n")
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: heartbeatSessionFile },
        "agent:main:tg:-5297593928:cmp9kwhbf0175209zotr1q9le": { sessionFile: "work.jsonl" },
      }),
      "utf8"
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("tg:-5297593928:cmp9kwhbf0175209zotr1q9le");
    expect(transcript?.latestUserMessage?.text).toBe("Complete the runtime scenario checks.");
  });

  it("uses OpenClaw runtime sessions and chat history across transports", async () => {
    const gateway = {
      request: vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "main", updatedAt: 8_000 },
              { key: "healthcheck-2026-06-03", updatedAt: 7_000 },
              { key: "agent:main:tg:100:server-a", updatedAt: 4_000 },
              { key: "agent:main:webchat:conversation-1", updatedAt: 6_000 },
            ],
          };
        }
        if (method === "chat.history") {
          expect(params).toMatchObject({ sessionKey: "agent:main:webchat:conversation-1" });
          return {
            messages: [
              { role: "assistant", createdAt: 5_900, content: "ready" },
              { role: "user", createdAt: 6_000, content: "newer webchat request" },
            ],
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("webchat:conversation-1");
    expect(transcript?.sessionFile).toBe("gateway://chat.history/agent:main:webchat:conversation-1");
    expect(transcript?.messages).toEqual([
      { role: "assistant", text: "ready", lineIndex: 0, timestampMs: 5_900 },
      { role: "user", text: "newer webchat request", lineIndex: 1, timestampMs: 6_000 },
    ]);
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
        finalConfidence: 10,
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

  it("keeps self-nudge replies on the original telegram route", async () => {
    const runChatTask = vi.fn().mockResolvedValue({
      result: { outcome: "no_reply", noReply: { runId: "run_1" } },
      openclawMeta: { method: "chat.send" },
    });

    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        sessionKey: "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
        mtimeMs: 10_000,
      }),
      state: makeState(),
      nowMs: 11_000,
      runner: { runChatTask },
      systemTaskTimeoutMs: 60_000,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue.",
        finalConfidence: 0,
      }),
    });

    expect(runChatTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
        originRoute: {
          originatingChannel: "relay-channel",
          originatingTo: "telegram:-5297593928",
        },
      })
    );
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
        finalConfidence: 0,
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
      decide: vi.fn().mockResolvedValue({ shouldNudge: false, statusNudgeMessage: null, finalConfidence: 0 }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(runChatTask).not.toHaveBeenCalled();
  });

  it("optionally notifies once when the model decides the latest request is final", async () => {
    const notifyFinalDecision = vi.fn<(input: FinalDecisionNotice) => Promise<void>>().mockResolvedValue(undefined);
    const state = makeState();
    const settings: RelaySelfNudgeSettings = {
      ...enabledSettings,
      finalNoticeEnabled: true,
    };
    const decision = vi.fn().mockResolvedValue({
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 97,
      reasonCode: "final_answer",
      reason: "assistant completed the request",
    });

    const first = await evaluateSelfNudgeTick({
      settings,
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          { role: "user", text: "please do x", lineIndex: 0 },
          { role: "assistant", text: "Done.", lineIndex: 1 },
        ],
      }),
      state,
      nowMs: 11_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      notifyFinalDecision,
      decide: decision,
    });
    const second = await evaluateSelfNudgeTick({
      settings,
      transcript: makeTranscript({
        mtimeMs: 12_000,
        messages: [
          { role: "user", text: "please do x", lineIndex: 0 },
          { role: "assistant", text: "Done.", lineIndex: 1 },
        ],
      }),
      state,
      nowMs: 13_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      notifyFinalDecision,
      decide: decision,
    });

    expect(first).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(second).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(notifyFinalDecision).toHaveBeenCalledTimes(1);
    const [notice] = notifyFinalDecision.mock.calls[0] as [FinalDecisionNotice];
    expect(notice.nowMs).toBe(11_000);
    expect(notice.decision.finalConfidence).toBe(97);
    expect(notice.decision.reasonCode).toBe("final_answer");
  });

  it("does not send final notices when final confidence is exactly 90", async () => {
    const notifyFinalDecision = vi.fn().mockResolvedValue(undefined);

    await evaluateSelfNudgeTick({
      settings: {
        ...enabledSettings,
        finalNoticeEnabled: true,
      },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          { role: "user", text: "please do x", lineIndex: 0 },
          { role: "assistant", text: "Probably done.", lineIndex: 1 },
        ],
      }),
      state: makeState(),
      nowMs: 11_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      notifyFinalDecision,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 90,
        reasonCode: "final_answer",
      }),
    });

    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("formats final notices with confidence, final assistant preview, and time", () => {
    const text = buildFinalDecisionNoticeText({
      transcript: makeTranscript({
        messages: [
          { role: "user", text: "please do x", lineIndex: 0, timestampMs: Date.UTC(2026, 5, 3, 11, 10) },
          {
            role: "assistant",
            text: "Finished the deployment and checks.",
            lineIndex: 1,
            timestampMs: Date.UTC(2026, 5, 3, 11, 11),
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "please do x",
          lineIndex: 0,
          timestampMs: Date.UTC(2026, 5, 3, 11, 10),
        },
      }),
      decision: {
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 97,
        reasonCode: "final_answer",
      },
      nowMs: Date.UTC(2026, 5, 3, 11, 12),
    });

    expect(text).toBe('FINAL(97%): message "Finished t..." from 11:11 is final');
  });

  it("does not send final notices for waiting-on-user decisions", async () => {
    const notifyFinalDecision = vi.fn().mockResolvedValue(undefined);

    await evaluateSelfNudgeTick({
      settings: {
        ...enabledSettings,
        finalNoticeEnabled: true,
      },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          { role: "user", text: "please do x", lineIndex: 0 },
          { role: "assistant", text: "Which repo should I use?", lineIndex: 1 },
        ],
      }),
      state: makeState(),
      nowMs: 11_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      notifyFinalDecision,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 40,
        reasonCode: "waiting_for_user",
      }),
    });

    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("persists final decisions so restart does not send delayed final notices for old messages", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-index-"));
    const firstStore = createFileSelfNudgeProcessedStore({ stateDir });
    const settings: RelaySelfNudgeSettings = {
      ...enabledSettings,
      finalNoticeEnabled: true,
    };
    const transcript = makeTranscript({
      mtimeMs: 10_000,
      messages: [
        { role: "user", text: "please do x", lineIndex: 0 },
        { role: "assistant", text: "Done.", lineIndex: 1 },
      ],
    });

    await evaluateSelfNudgeTick({
      settings,
      transcript,
      state: makeState(),
      nowMs: 11_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      processedStore: firstStore,
      notifyFinalDecision: vi.fn().mockResolvedValue(undefined),
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 100,
        reasonCode: "final_answer",
        reason: "assistant completed the request",
      }),
    });

    const afterRestartNotice = vi.fn().mockResolvedValue(undefined);
    const afterRestartDecision = vi.fn().mockResolvedValue({
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 100,
      reasonCode: "final_answer",
    });
    const result = await evaluateSelfNudgeTick({
      settings,
      transcript: makeTranscript({
        ...transcript,
        mtimeMs: 20_000,
      }),
      state: makeState(),
      nowMs: 21_000,
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      processedStore: createFileSelfNudgeProcessedStore({ stateDir }),
      notifyFinalDecision: afterRestartNotice,
      decide: afterRestartDecision,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(afterRestartDecision).not.toHaveBeenCalled();
    expect(afterRestartNotice).not.toHaveBeenCalled();
  });

  it("does not send delayed final notices for stale user messages from old sessions", async () => {
    const notifyFinalDecision = vi.fn().mockResolvedValue(undefined);
    const decide = vi.fn().mockResolvedValue({
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 100,
      reasonCode: "final_answer",
    });

    const result = await evaluateSelfNudgeTick({
      settings: {
        ...enabledSettings,
        finalNoticeEnabled: true,
      },
      transcript: makeTranscript({
        mtimeMs: Date.UTC(2026, 5, 3, 16, 40),
        messages: [
          {
            role: "user",
            text: "please do old work",
            lineIndex: 0,
            timestampMs: Date.UTC(2026, 4, 21, 15, 20),
          },
          {
            role: "assistant",
            text: "Status: done.",
            lineIndex: 1,
            timestampMs: Date.UTC(2026, 4, 21, 15, 21),
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "please do old work",
          lineIndex: 0,
          timestampMs: Date.UTC(2026, 4, 21, 15, 20),
        },
      }),
      state: makeState(),
      nowMs: Date.UTC(2026, 5, 3, 16, 43),
      runner: { runChatTask: vi.fn() },
      systemTaskTimeoutMs: 60_000,
      notifyFinalDecision,
      decide,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(decide).not.toHaveBeenCalled();
    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("does not double-prefix status nudge messages", () => {
    expect(formatStatusNudgeMessage("[STATUS_NUDGE]\nContinue.")).toBe("[STATUS_NUDGE]\nContinue.");
  });

  it("uses the configured OpenRouter provider proxy path for analysis", () => {
    expect(
      buildOpenRouterProxyChatCompletionsUrl({
        port: 18080,
        pathPrefix: "/provider-proxy/openrouter/",
      })
    ).toBe("http://127.0.0.1:18080/provider-proxy/openrouter/api/v1/chat/completions");
  });
});
