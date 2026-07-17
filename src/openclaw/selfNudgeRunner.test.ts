import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFinalDecisionNoticeText,
  buildNudgeDecisionNoticeText,
  buildOpenRouterProxyChatCompletionsUrl,
  buildSelfNudgeAnalysisTranscript,
  computeSelfNudgeWaitMs,
  createFileSelfNudgeProcessedStore,
  createSelfNudgeRunner,
  evaluateSelfNudgeTick,
  findVisibleFinalityInOpenclawRuntimeHistory,
  formatStatusNudgeMessage,
  hasActiveOpenclawRuntimeWork,
  readFreshestOpenclawRuntimeTranscript,
  readFreshestSessionTranscript,
  STATUS_NUDGE_MESSAGE,
  type FreshestSessionTranscript,
  type RelaySelfNudgeSettings,
  type SelfNudgeDecision,
  type SelfNudgeMessageSender,
  type SelfNudgeState,
} from "./selfNudgeRunner.js";

const enabledSettings: RelaySelfNudgeSettings = {
  enabled: true,
  analyzedRecentMessageCount: 1,
  baseTimeoutMs: 1_000,
  model: "openrouter/google/gemini-test",
  debugMessagesEnabled: false,
  nudgeNoticeEnabled: false,
  finalNoticeEnabled: false,
  finalNoticeText: "Final message.",
};

function makeSendNudgeMessageMock() {
  return vi.fn<SelfNudgeMessageSender>().mockResolvedValue(undefined);
}

type FinalDecisionNotice = {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  nowMs: number;
};

type NudgeDecisionNotice = {
  transcript: FreshestSessionTranscript;
  decision: SelfNudgeDecision;
  messageText: string;
  taskId: string;
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

function makeTranscript(
  input?: Partial<FreshestSessionTranscript>,
): FreshestSessionTranscript {
  return {
    sessionKey: "s1",
    sessionFile: "/tmp/s1.jsonl",
    mtimeMs: 10_000,
    messages: [{ role: "user", text: "please finish this task", lineIndex: 0 }],
    latestUserMessage: {
      role: "user",
      text: "please finish this task",
      lineIndex: 0,
    },
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
        debugMessagesEnabled: false,
        nudgeNoticeEnabled: false,
        finalNoticeEnabled: false,
        finalNoticeText: "Final answer detected.",
      },
      stateDir: await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-state-")),
      sendNudgeMessage: makeSendNudgeMessageMock(),
      openrouterProxyPort: 18080,
      openrouterProxyPathPrefix: "/provider-proxy/openrouter",
      pollIntervalMs: 1_000,
    });

    await expect(runner.tick()).resolves.toBeUndefined();
  });

  it("does not fall back to session files when OpenClaw gateway is unavailable", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-state-"),
    );
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "active.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          timestamp: 4_000,
          content: "finish this direct request",
        },
      }),
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:telegram:direct:449985919": { sessionFile },
      }),
      "utf8",
    );
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("should not call model"));
    const runner = createSelfNudgeRunner({
      settings: enabledSettings,
      stateDir,
      sendNudgeMessage,
      openrouterProxyPort: 18080,
      openrouterProxyPathPrefix: "/provider-proxy/openrouter",
      pollIntervalMs: 1_000,
      fetchImpl,
    });

    await runner.tick(5_000);
    runner.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("selects the OpenClaw session with the newest user request and returns that request plus N later assistant messages", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-state-"),
    );
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const completedSessionFile = path.join(sessionsDir, "completed.jsonl");
    const activeSessionFile = path.join(sessionsDir, "active.jsonl");
    await fs.writeFile(
      completedSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", timestamp: 1_000, content: "older request" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", timestamp: 1_100, content: "Done." },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      activeSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", timestamp: 4_000, content: "first" },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 4_100,
            content: [{ type: "text", text: "working" }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", timestamp: 4_200, content: "latest" },
        }),
      ].join("\n"),
    );
    await fs.utimes(completedSessionFile, new Date(5_000), new Date(5_000));
    await fs.utimes(activeSessionFile, new Date(2_000), new Date(2_000));
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:completed": { sessionFile: completedSessionFile },
        "agent:main:active": { sessionFile: "active.jsonl" },
      }),
      "utf8",
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("active");
    expect(transcript?.messages).toEqual([
      {
        role: "user",
        text: "latest",
        lineIndex: 2,
        timestampMs: 4_200,
        isLatestUserRequest: true,
      },
    ]);
    expect(transcript?.latestUserMessage).toEqual({
      role: "user",
      text: "latest",
      lineIndex: 2,
      timestampMs: 4_200,
      isLatestUserRequest: true,
    });
  });

  it("excludes messages before the latest real user request and keeps only configured assistant replies after it", () => {
    const analysis = buildSelfNudgeAnalysisTranscript({
      analyzedRecentMessageCount: 2,
      messages: [
        { role: "user", text: "old request", lineIndex: 0 },
        { role: "assistant", text: "old answer", lineIndex: 1 },
        { role: "user", text: "do all tasks", lineIndex: 2 },
        { role: "assistant", text: "task 1 done", lineIndex: 3 },
        { role: "user", text: "[STATUS_NUDGE]\nContinue.", lineIndex: 4 },
        {
          role: "assistant",
          text: "task 2 done, task 3 remains",
          lineIndex: 5,
        },
        { role: "assistant", text: "still checking task 3", lineIndex: 6 },
      ],
    });

    expect(analysis?.latestUserMessage).toEqual({
      role: "user",
      text: "do all tasks",
      lineIndex: 2,
      isLatestUserRequest: true,
    });
    expect(analysis?.messages).toEqual([
      {
        role: "user",
        text: "do all tasks",
        lineIndex: 2,
        isLatestUserRequest: true,
      },
      { role: "assistant", text: "task 2 done, task 3 remains", lineIndex: 5 },
      { role: "assistant", text: "still checking task 3", lineIndex: 6 },
    ]);
  });

  it("ignores internal maintenance sessions when choosing a nudge transcript", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-state-"),
    );
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
            content:
              "Read HEARTBEAT.md if it exists. If nothing needs attention, reply HEARTBEAT_OK.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 5_100,
            content: "HEARTBEAT_OK",
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      workSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 4_000,
            content: "Complete the runtime scenario checks.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", timestamp: 4_100, content: "Working." },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:main": { sessionFile: heartbeatSessionFile },
        "agent:main:tg:-5297593928:cmp9kwhbf0175209zotr1q9le": {
          sessionFile: "work.jsonl",
        },
      }),
      "utf8",
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe(
      "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
    );
    expect(transcript?.latestUserMessage?.text).toBe(
      "Complete the runtime scenario checks.",
    );
  });

  it("keeps user-facing status nudge sessions eligible for follow-up nudges", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-state-"),
    );
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const nudgeSessionFile = path.join(sessionsDir, "nudge.jsonl");
    await fs.writeFile(
      nudgeSessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 4_000,
            content: "continue doing tracker tasks",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 4_100,
            content: "Closed the first batch. Next is #150.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 4_200,
            content: "[STATUS_NUDGE]\nProceed with #150 and report progress.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 4_300,
            content: "Commit for #150 is ready. Closing the issue now.",
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:tg:-5297593928:cmp9kwhbf0175209zotr1q9le": {
          sessionFile: "nudge.jsonl",
        },
      }),
      "utf8",
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.sessionKey).toBe(
      "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
    );
    expect(transcript?.latestUserMessage?.text).toBe(
      "continue doing tracker tasks",
    );
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      "continue doing tracker tasks",
      "Closed the first batch. Next is #150.",
      "Commit for #150 is ready. Closing the issue now.",
    ]);
    expect(transcript?.messages[0]?.isLatestUserRequest).toBe(true);
  });

  it("ignores pre-compaction memory flush turns when choosing the latest user request", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-state-"),
    );
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "sacra.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 4_000,
            content: "выполняй все задачи с тасктрекера пока их не сделаешь",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 4_100,
            content: "Продолжаю с первой открытой задачей.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            timestamp: 4_200,
            content:
              "Pre-compaction memory flush. Store durable memories only in memory/2026-06-10.md (create memory/ if needed). If nothing to store, reply with NO_REPLY.",
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            timestamp: 4_300,
            content: "NO_REPLY",
          },
        }),
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:tg:-5297593928:cmp9kwhbf0175209zotr1q9le": {
          sessionFile: "sacra.jsonl",
        },
      }),
      "utf8",
    );

    const transcript = await readFreshestSessionTranscript({
      stateDir,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.sessionKey).toBe(
      "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
    );
    expect(transcript?.latestUserMessage?.text).toBe(
      "выполняй все задачи с тасктрекера пока их не сделаешь",
    );
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      "выполняй все задачи с тасктрекера пока их не сделаешь",
      "Продолжаю с первой открытой задачей.",
      "NO_REPLY",
    ]);
  });

  it("uses OpenClaw runtime sessions and chat history across transports", async () => {
    const historyBySession = new Map<string, unknown>([
      [
        "agent:main:tg:100:server-a",
        {
          messages: [
            { role: "assistant", createdAt: 3_900, content: "ready" },
            {
              role: "user",
              createdAt: 4_000,
              content: "older telegram request",
            },
          ],
        },
      ],
      [
        "agent:main:webchat:conversation-1",
        {
          messages: [
            { role: "assistant", createdAt: 5_900, content: "ready" },
            {
              role: "user",
              createdAt: 6_000,
              content: "newer webchat request",
            },
          ],
        },
      ],
    ]);
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          expect(params).toEqual({ agentId: "main", limit: 50 });
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
          expect(params).toMatchObject({ limit: 100 });
          const sessionKey = (params as { sessionKey?: string } | undefined)
            ?.sessionKey;
          const payload = sessionKey ? historyBySession.get(sessionKey) : null;
          if (payload) return payload;
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 1,
    });

    expect(transcript?.sessionKey).toBe("webchat:conversation-1");
    expect(transcript?.sessionFile).toBe(
      "gateway://chat.history/agent:main:webchat:conversation-1",
    );
    expect(transcript?.messages).toEqual([
      {
        role: "user",
        text: "newer webchat request",
        lineIndex: 1,
        timestampMs: 6_000,
        isLatestUserRequest: true,
      },
    ]);
  });

  it("uses edited runtime messages as session activity for self-nudge timing", async () => {
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:tg:-5297593928:server-a", updatedAt: 10_000 },
            ],
          };
        }
        if (method === "chat.history") {
          expect(params).toMatchObject({
            sessionKey: "agent:main:tg:-5297593928:server-a",
          });
          return {
            messages: [
              {
                role: "user",
                createdAt: 10_000,
                content: "release everything",
              },
              {
                role: "assistant",
                createdAt: 10_100,
                updatedAt: 14_500,
                content: "Edited status: tests are still running.",
              },
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

    expect(transcript?.mtimeMs).toBe(14_500);
    expect(transcript?.messages).toEqual([
      {
        role: "user",
        text: "release everything",
        lineIndex: 0,
        timestampMs: 10_000,
        isLatestUserRequest: true,
      },
      {
        role: "assistant",
        text: "Edited status: tests are still running.",
        lineIndex: 1,
        timestampMs: 14_500,
      },
    ]);
  });

  it("keeps runtime status nudge sessions eligible for follow-up nudges", async () => {
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          expect(params).toEqual({ agentId: "main", limit: 50 });
          return {
            sessions: [
              { key: "agent:main:tg:-5297593928:server-a", updatedAt: 4_300 },
            ],
          };
        }
        if (method === "chat.history") {
          expect(params).toMatchObject({
            sessionKey: "agent:main:tg:-5297593928:server-a",
          });
          return {
            messages: [
              { role: "user", createdAt: 4_000, content: "continue tasks" },
              {
                role: "assistant",
                createdAt: 4_100,
                content: "Next item is #150.",
              },
              {
                role: "user",
                createdAt: 4_200,
                content: "[STATUS_NUDGE]\nProceed with #150.",
              },
              {
                role: "assistant",
                createdAt: 4_300,
                content: "Working on #150.",
              },
            ],
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.sessionKey).toBe("tg:-5297593928:server-a");
    expect(transcript?.latestUserMessage?.text).toBe("continue tasks");
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      "continue tasks",
      "Next item is #150.",
      "Working on #150.",
    ]);
    expect(transcript?.messages[0]?.isLatestUserRequest).toBe(true);
  });

  it("excludes relay-owned assistant notices from runtime analysis history", async () => {
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:tg:-5297593928:server-a", updatedAt: 10_000 },
            ],
          };
        }
        if (method === "chat.history") {
          expect(params).toMatchObject({
            sessionKey: "agent:main:tg:-5297593928:server-a",
          });
          return {
            messages: [
              {
                role: "user",
                createdAt: 4_000,
                content: "complete the prod verification",
              },
              {
                role: "assistant",
                createdAt: 4_100,
                content: "I am checking prod now.",
              },
              {
                role: "assistant",
                createdAt: 4_500,
                idempotencyKey: "system-notification:credits.exhausted",
                content: "Credits are exhausted",
              },
              {
                role: "assistant",
                createdAt: 5_000,
                content:
                  'FINAL(100%): message "I am chec..." from 04:10 is final',
              },
              {
                role: "assistant",
                createdAt: 6_000,
                content:
                  'NUDGE(40% final): latest user "complete the prod verification" assistant "I am checking prod now."\n[STATUS_NUDGE]\nContinue.',
              },
            ],
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.mtimeMs).toBe(4_100);
    expect(transcript?.messages.map((message) => message.text)).toEqual([
      "complete the prod verification",
      "I am checking prod now.",
    ]);
  });

  it("chooses runtime sessions by latest real user request instead of session updatedAt", async () => {
    const historyBySession = new Map<string, unknown>([
      [
        "agent:main:telegram:group:-old",
        {
          messages: [
            { role: "user", createdAt: 1_000, content: "old user task" },
            {
              role: "assistant",
              createdAt: 8_000,
              content: "Still working on old task.",
            },
            {
              role: "user",
              createdAt: 9_000,
              content: "[STATUS_NUDGE]\nContinue old task.",
            },
            {
              role: "assistant",
              createdAt: 9_100,
              content: "Continuing old task.",
            },
          ],
        },
      ],
      [
        "agent:main:telegram:group:-current",
        {
          messages: [
            { role: "user", createdAt: 7_000, content: "new user task" },
            {
              role: "assistant",
              createdAt: 7_500,
              content: "I am working on the new task.",
            },
          ],
        },
      ],
    ]);
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:telegram:group:-old", updatedAt: 9_100 },
              { key: "agent:main:telegram:group:-current", updatedAt: 7_500 },
            ],
          };
        }
        if (method === "chat.history") {
          const sessionKey = (params as { sessionKey?: string } | undefined)
            ?.sessionKey;
          const payload = sessionKey ? historyBySession.get(sessionKey) : null;
          if (payload) return payload;
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.sessionKey).toBe("telegram:group:-current");
    expect(transcript?.latestUserMessage?.text).toBe("new user task");
  });

  it("ignores newer internal runtime sessions with private final text when direct Telegram is waiting", async () => {
    const historyBySession = new Map<string, unknown>([
      [
        "agent:main:internal:codex-final",
        {
          messages: [
            { role: "user", createdAt: 9_000, content: "internal bookkeeping" },
            {
              role: "assistant",
              createdAt: 9_500,
              content: "Done. Visible reply sent.",
            },
          ],
        },
      ],
      [
        "agent:main:telegram:direct:449985919",
        {
          messages: [
            {
              role: "user",
              createdAt: 7_000,
              content: "continue the tracker tasks",
            },
            {
              role: "assistant",
              createdAt: 7_500,
              content: "Working on the next tracker task.",
            },
          ],
        },
      ],
    ]);
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:internal:codex-final", updatedAt: 9_500 },
              { key: "agent:main:telegram:direct:449985919", updatedAt: 7_500 },
            ],
          };
        }
        if (method === "chat.history") {
          const sessionKey = (params as { sessionKey?: string } | undefined)
            ?.sessionKey;
          const payload = sessionKey ? historyBySession.get(sessionKey) : null;
          if (payload) return payload;
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript?.sessionKey).toBe("telegram:direct:449985919");
    expect(transcript?.latestUserMessage?.text).toBe(
      "continue the tracker tasks",
    );
  });

  it("detects active OpenClaw sessions and process-bearing runtime records", () => {
    expect(
      hasActiveOpenclawRuntimeWork({
        sessions: [{ key: "agent:main:telegram:group:-1", status: "running" }],
      }),
    ).toBe(true);
    expect(
      hasActiveOpenclawRuntimeWork({
        sessions: [{ key: "agent:main:subagent:worker", hasActiveRun: true }],
      }),
    ).toBe(true);
    expect(
      hasActiveOpenclawRuntimeWork({
        sessions: [{ key: "agent:main:main", status: "done", hasActiveRun: false }],
      }),
    ).toBe(false);
  });

  it("does not inspect chat history while any OpenClaw session is active", async () => {
    const gateway = {
      request: vi.fn((method: string) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              {
                key: "agent:main:telegram:group:-current",
                updatedAt: 10_000,
                status: "running",
                hasActiveRun: true,
              },
              {
                key: "agent:main:telegram:group:-older",
                updatedAt: 9_000,
                status: "done",
                hasActiveRun: false,
              },
            ],
          };
        }
        throw new Error(`chat history must not be read while active: ${method}`);
      }),
    };

    const transcript = await readFreshestOpenclawRuntimeTranscript({
      gateway,
      analyzedRecentMessageCount: 3,
    });

    expect(transcript).toBeNull();
    expect(gateway.request).toHaveBeenCalledTimes(1);
    expect(gateway.request).toHaveBeenCalledWith(
      "sessions.list",
      { agentId: "main", limit: 50 },
      { timeoutMs: 5_000 },
    );
  });

  it("does not read runtime state when local relay work is active", async () => {
    const gateway = { request: vi.fn() };
    const fetchImpl = vi.fn<typeof fetch>();
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const runner = createSelfNudgeRunner({
      settings: enabledSettings,
      sendNudgeMessage,
      openrouterProxyPort: 18080,
      openrouterProxyPathPrefix: "/provider-proxy/openrouter",
      fetchImpl,
      gateway,
      isLocallyIdle: () => false,
    });

    await runner.tick(20_000);
    runner.stop();

    expect(gateway.request).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("marks the latest real user request in the analyzer payload without duplicating status nudges", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const body = typeof init?.body === "string" ? init.body : "";
        const payload = JSON.parse(body) as {
          messages: Array<{ role: string; content: string }>;
        };
        const systemPrompt = payload.messages[0]?.content ?? "";
        expect(systemPrompt).not.toContain("greater than 90");
        expect(systemPrompt).not.toContain("90 or lower");
        expect(systemPrompt).not.toContain(">90");
        expect(systemPrompt).not.toMatch(
          /\bPR\b|pull request|release not run|deployment not run/i,
        );
        expect(systemPrompt).toContain(
          "first determine what concrete actions the assistant actually completed",
        );
        expect(systemPrompt).toContain("then judge whether those actions make the request final");
        expect(systemPrompt).not.toContain("statusNudgeMessage");
        expect(systemPrompt).toContain("do not generate nudge text");
        const analyzerInput = JSON.parse(
          payload.messages[1]?.content ?? "{}",
        ) as {
          latestMessages: Array<Record<string, unknown>>;
        };
        expect(analyzerInput.latestMessages).toEqual([
          {
            role: "user",
            text: "finish every release task",
            isLatestUserRequest: true,
          },
          {
            role: "assistant",
            text: "Two tasks are done, one release task remains.",
          },
        ]);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      shouldNudge: true,
                      statusNudgeMessage:
                        "Continue the remaining release task from the user's request and report new evidence.",
                      finalConfidence: 30,
                      reasonCode: "unknown",
                      reason: "assistant reported remaining work",
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      },
    );
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.list") {
          return {
            sessions: [
              { key: "agent:main:tg:-5297593928:server-a", updatedAt: 8_000 },
            ],
          };
        }
        if (method === "chat.history") {
          expect(params).toMatchObject({
            sessionKey: "agent:main:tg:-5297593928:server-a",
            limit: 100,
          });
          return {
            messages: [
              { role: "user", createdAt: 1_000, content: "old request" },
              { role: "assistant", createdAt: 2_000, content: "old answer" },
              {
                role: "user",
                createdAt: 3_000,
                content: "finish every release task",
              },
              {
                role: "assistant",
                createdAt: 4_000,
                content: "First release task is done.",
              },
              {
                role: "user",
                createdAt: 5_000,
                content: "[STATUS_NUDGE]\nContinue the release.",
              },
              {
                role: "assistant",
                createdAt: 6_000,
                content: "Two tasks are done, one release task remains.",
              },
            ],
          };
        }
        throw new Error(`unexpected gateway method ${method}`);
      }),
    };
    const runner = createSelfNudgeRunner({
      settings: {
        ...enabledSettings,
        analyzedRecentMessageCount: 1,
      },
      stateDir: await fs.mkdtemp(path.join(os.tmpdir(), "gwr-nudge-payload-")),
      sendNudgeMessage: makeSendNudgeMessageMock(),
      openrouterProxyPort: 18080,
      openrouterProxyPathPrefix: "/provider-proxy/openrouter",
      fetchImpl,
      gateway,
    });

    await runner.tick(9_000);
    runner.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("waits for T * (X + 1), sends a marked self-nudge, then increases backoff", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const state = makeState();

    const early = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 10_500,
      sendNudgeMessage,
      decide: vi.fn(),
    });
    expect(early).toEqual({ nudged: false, nextDelayMs: 500 });
    expect(sendNudgeMessage).not.toHaveBeenCalled();

    const sent = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 11_000,
      sendNudgeMessage,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage:
          "Continue with the migration and report the next concrete step.",
        finalConfidence: 10,
      }),
    });

    expect(sent).toEqual({ nudged: true, nextDelayMs: 2_000 });
    const sentNudge = sendNudgeMessage.mock.calls[0]?.[0];
    expect(sentNudge?.transcript.sessionKey).toBe("s1");
    expect(sentNudge?.messageText).toBe(STATUS_NUDGE_MESSAGE);
    expect(computeSelfNudgeWaitMs(1_000, state.consecutiveNudges)).toBe(2_000);
  });

  it("does not run the action/finality analyzer when idle confirmation fails", async () => {
    const decide = vi.fn();
    const sendNudgeMessage = makeSendNudgeMessageMock();

    const result = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      confirmIdle: () => false,
      decide,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(decide).not.toHaveBeenCalled();
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("drops a pending nudge when activity starts during model analysis", async () => {
    const confirmIdle = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const processedStore = {
      get: vi.fn().mockResolvedValue(null),
      markAnalyzed: vi.fn().mockResolvedValue(undefined),
      markFinalNoticeSent: vi.fn().mockResolvedValue(undefined),
    };

    const result = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      processedStore,
      confirmIdle,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Model-generated instructions must be ignored.",
        finalConfidence: 20,
        reasonCode: "unknown",
      }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(confirmIdle).toHaveBeenCalledTimes(2);
    expect(sendNudgeMessage).not.toHaveBeenCalled();
    expect(processedStore.markAnalyzed).not.toHaveBeenCalled();
  });

  it("does not nudge while a recent edited status update is inside the wait window", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const decide = vi.fn().mockResolvedValue({
      shouldNudge: true,
      statusNudgeMessage: "Continue.",
      finalConfidence: 10,
    });

    const result = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        mtimeMs: 14_500,
        messages: [
          {
            role: "user",
            text: "release everything",
            lineIndex: 0,
            timestampMs: 10_000,
          },
          {
            role: "assistant",
            text: "Edited status: tests are still running.",
            lineIndex: 1,
            timestampMs: 14_500,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "release everything",
          lineIndex: 0,
          timestampMs: 10_000,
        },
      }),
      state: makeState(),
      nowMs: 15_000,
      sendNudgeMessage,
      decide,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 500 });
    expect(decide).not.toHaveBeenCalled();
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("uses a fresh assistant message timestamp as activity even when transcript mtime is stale", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const decide = vi.fn().mockResolvedValue({
      shouldNudge: true,
      statusNudgeMessage: "Continue.",
      finalConfidence: 70,
    });

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, baseTimeoutMs: 300_000 },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          {
            role: "user",
            text: "debug the prod agent",
            lineIndex: 0,
            timestampMs: 0,
          },
          {
            role: "assistant",
            text: "Proxy is fixed; now running the embedded smoke test.",
            lineIndex: 1,
            timestampMs: 118_000,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "debug the prod agent",
          lineIndex: 0,
          timestampMs: 0,
        },
      }),
      state: makeState(),
      nowMs: 120_000,
      sendNudgeMessage,
      decide,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 298_000 });
    expect(decide).not.toHaveBeenCalled();
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("does not repeat the same persisted nudge when the analysis transcript is unchanged", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-once-"),
    );
    const processedStore = createFileSelfNudgeProcessedStore({ stateDir });
    const transcript = makeTranscript({ mtimeMs: 10_000 });
    const firstSender = makeSendNudgeMessageMock();

    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript,
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage: firstSender,
      processedStore,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue with the migration.",
        finalConfidence: 10,
      }),
    });

    const secondSender = makeSendNudgeMessageMock();
    const secondDecision = vi.fn().mockResolvedValue({
      shouldNudge: true,
      statusNudgeMessage: "Continue with the migration again.",
      finalConfidence: 10,
    });
    const second = await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ ...transcript, mtimeMs: 30_000 }),
      state: makeState(),
      nowMs: 31_000,
      sendNudgeMessage: secondSender,
      processedStore: createFileSelfNudgeProcessedStore({ stateDir }),
      decide: secondDecision,
    });

    expect(firstSender).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(secondDecision).not.toHaveBeenCalled();
    expect(secondSender).not.toHaveBeenCalled();
  });

  it("rechecks a previously nudged request when assistant messages change", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-recheck-"),
    );
    const processedStore = createFileSelfNudgeProcessedStore({ stateDir });
    const transcript = makeTranscript({ mtimeMs: 10_000 });

    await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript,
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage: makeSendNudgeMessageMock(),
      processedStore,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue with the migration.",
        finalConfidence: 10,
      }),
    });

    const finalNotice = vi.fn().mockResolvedValue(undefined);
    const finalDecision = vi.fn().mockResolvedValue({
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 100,
      reasonCode: "final_answer",
    });
    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        ...transcript,
        mtimeMs: 30_000,
        messages: [
          { role: "user", text: "please finish this task", lineIndex: 0 },
          { role: "assistant", text: "Done.", lineIndex: 2 },
        ],
      }),
      state: makeState(),
      nowMs: 31_000,
      sendNudgeMessage: makeSendNudgeMessageMock(),
      processedStore: createFileSelfNudgeProcessedStore({ stateDir }),
      notifyFinalDecision: finalNotice,
      decide: finalDecision,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(finalDecision).toHaveBeenCalledTimes(1);
    expect(finalNotice).toHaveBeenCalledTimes(1);
  });

  it("does not close a turn on private final text without visible finality evidence", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          {
            role: "user",
            text: "send the answer in telegram",
            lineIndex: 0,
            timestampMs: 9_000,
          },
          {
            role: "assistant",
            text: "Done. Visible reply sent.",
            lineIndex: 1,
            timestampMs: 10_000,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "send the answer in telegram",
          lineIndex: 0,
          timestampMs: 9_000,
        },
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      notifyFinalDecision,
      findVisibleFinality: vi.fn().mockResolvedValue(null),
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 100,
        reasonCode: "final_answer",
      }),
    });

    expect(result).toEqual({ nudged: true, nextDelayMs: 2_000 });
    expect(sendNudgeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: STATUS_NUDGE_MESSAGE,
      }),
    );
    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("allows final closure when visible finality evidence exists", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          {
            role: "user",
            text: "send the answer in telegram",
            lineIndex: 0,
            timestampMs: 9_000,
          },
          {
            role: "assistant",
            text: "Private final text.",
            lineIndex: 1,
            timestampMs: 10_000,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "send the answer in telegram",
          lineIndex: 0,
          timestampMs: 9_000,
        },
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      notifyFinalDecision,
      findVisibleFinality: vi.fn().mockResolvedValue({
        visibleText: "Visible Telegram answer.",
        deliveredAtMs: 10_500,
        deliveryKind: "final",
      }),
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 100,
        reasonCode: "final_answer",
      }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(sendNudgeMessage).not.toHaveBeenCalled();
    const expectedVisibleFinality = expect.objectContaining({
      visibleText: "Visible Telegram answer.",
    }) as unknown;
    expect(notifyFinalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleFinality: expectedVisibleFinality,
      }),
    );
  });

  it("treats successful OpenClaw message tool sends as visible finality evidence", async () => {
    const gateway = {
      request: vi.fn((method: string, params?: unknown) => {
        expect(method).toBe("chat.history");
        expect(params).toMatchObject({
          sessionKey: "telegram:direct:449985919",
        });
        return Promise.resolve({
          messages: [
            {
              role: "user",
              createdAt: 10_000,
              content: "а че там за репорты?",
            },
            {
              role: "assistant",
              createdAt: 11_000,
              content: [
                {
                  type: "toolCall",
                  name: "message",
                  arguments: {
                    action: "send",
                    message: "Да, есть weekly analytics reports по GA4.",
                  },
                },
              ],
            },
          ],
        });
      }),
    };

    const evidence = await findVisibleFinalityInOpenclawRuntimeHistory({
      gateway,
      sessionKey: "telegram:direct:449985919",
      afterMs: 10_000,
    });

    expect(evidence).toEqual({
      visibleText: "Да, есть weekly analytics reports по GA4.",
      deliveredAtMs: 11_000,
      deliveryKind: "final",
    });
  });

  it("closes final answers when OpenClaw message tool delivery is present in runtime history", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);
    const gateway = {
      request: vi.fn(() =>
        Promise.resolve({
          messages: [
            {
              role: "user",
              createdAt: 10_000,
              content: "а че там за репорты?",
            },
            {
              role: "assistant",
              createdAt: 11_000,
              content: [
                {
                  type: "toolCall",
                  name: "message",
                  arguments: JSON.stringify({
                    action: "send",
                    message: "Да, есть weekly analytics reports по GA4.",
                  }),
                },
              ],
            },
          ],
        }),
      ),
    };

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        sessionKey: "telegram:direct:449985919",
        mtimeMs: 11_000,
        messages: [
          {
            role: "user",
            text: "а че там за репорты?",
            lineIndex: 0,
            timestampMs: 10_000,
          },
          {
            role: "assistant",
            text: "Да, есть weekly analytics reports по GA4.",
            lineIndex: 1,
            timestampMs: 11_000,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "а че там за репорты?",
          lineIndex: 0,
          timestampMs: 10_000,
        },
      }),
      state: makeState(),
      nowMs: 12_000,
      sendNudgeMessage,
      notifyFinalDecision,
      findVisibleFinality: ({ transcript }) =>
        findVisibleFinalityInOpenclawRuntimeHistory({
          gateway,
          sessionKey: transcript.sessionKey,
          afterMs: transcript.latestUserMessage?.timestampMs,
        }),
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 100,
        reasonCode: "final_answer",
      }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(sendNudgeMessage).not.toHaveBeenCalled();
    expect(notifyFinalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        visibleFinality: expect.objectContaining({
          visibleText: "Да, есть weekly analytics reports по GA4.",
        }) as unknown,
      }),
    );
  });

  it("still asks the model to judge assistant replies that claim Status 100 complete", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const decide = vi.fn().mockResolvedValue({
      shouldNudge: true,
      statusNudgeMessage:
        "The assistant claimed completion, but the original request still needs verification.",
      finalConfidence: 10,
    });
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          { role: "user", text: "please finish this task", lineIndex: 0 },
          {
            role: "assistant",
            text: "Everything requested is done.\n\nStatus: 100% complete",
            lineIndex: 1,
          },
        ],
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      notifyFinalDecision,
      decide,
    });

    expect(result).toEqual({ nudged: true, nextDelayMs: 2_000 });
    expect(decide).toHaveBeenCalledTimes(1);
    const [decisionInput] = decide.mock.calls[0] as [
      { transcript: FreshestSessionTranscript },
    ];
    expect(decisionInput.transcript.messages).toEqual([
      { role: "user", text: "please finish this task", lineIndex: 0 },
      {
        role: "assistant",
        text: "Everything requested is done.\n\nStatus: 100% complete",
        lineIndex: 1,
      },
    ]);
    expect(sendNudgeMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageText: STATUS_NUDGE_MESSAGE,
      }),
    );
    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("nudges when the model classifies a progress update as unfinished", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);

    const result = await evaluateSelfNudgeTick({
      settings: { ...enabledSettings, finalNoticeEnabled: true },
      transcript: makeTranscript({
        mtimeMs: 10_000,
        messages: [
          {
            role: "user",
            text: "Продолжай #117 safety guardrails до результата.",
            lineIndex: 0,
          },
          {
            role: "assistant",
            text: "PR #119 сейчас open, mergeable, GitHub checks green. Релизов/деплоев не запускал.",
            lineIndex: 1,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "Продолжай #117 safety guardrails до результата.",
          lineIndex: 0,
        },
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      notifyFinalDecision,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage:
          "Continue #117: the latest update only reports a ready PR and says release/deploy were not run. Report new evidence.",
        finalConfidence: 70,
        reasonCode: "unknown",
        reason: "latest assistant message reports a partial outcome",
      }),
    });

    expect(result).toEqual({ nudged: true, nextDelayMs: 2_000 });
    expect(notifyFinalDecision).not.toHaveBeenCalled();
    const sentNudge = sendNudgeMessage.mock.calls[0]?.[0];
    expect(sentNudge?.decision.finalConfidence).toBe(70);
    expect(sentNudge?.decision.reasonCode).toBe("unknown");
    expect(sentNudge?.decision.reason).toContain("partial outcome");
    expect(sentNudge?.messageText).toBe(STATUS_NUDGE_MESSAGE);
  });

  it("sends a user-visible debug notice with confidence and the status nudge message when enabled", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const notifyNudgeDecision = vi
      .fn<(input: NudgeDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);

    await evaluateSelfNudgeTick({
      settings: {
        ...enabledSettings,
        debugMessagesEnabled: true,
        nudgeNoticeEnabled: true,
      },
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      notifyNudgeDecision,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue with the migration.",
        finalConfidence: 37,
      }),
    });

    expect(notifyNudgeDecision).toHaveBeenCalledTimes(1);
    const notice = notifyNudgeDecision.mock.calls[0]?.[0];
    expect(notice?.messageText).toBe(STATUS_NUDGE_MESSAGE);
    expect(notice?.decision.finalConfidence).toBe(37);
  });

  it("passes status nudges to a user-owned conversation sender", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();

    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        sessionKey: "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
        mtimeMs: 10_000,
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue.",
        finalConfidence: 0,
      }),
    });

    const sentNudge = sendNudgeMessage.mock.calls[0]?.[0];
    expect(sentNudge?.transcript.sessionKey).toBe(
      "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
    );
    expect(sentNudge?.messageText).toBe(STATUS_NUDGE_MESSAGE);
  });

  it("keeps self-nudge turns on the original telegram session", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();

    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({
        sessionKey: "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
        mtimeMs: 10_000,
      }),
      state: makeState(),
      nowMs: 11_000,
      sendNudgeMessage,
      decide: vi.fn().mockResolvedValue({
        shouldNudge: true,
        statusNudgeMessage: "Continue.",
        finalConfidence: 0,
      }),
    });

    const sentNudge = sendNudgeMessage.mock.calls[0]?.[0];
    expect(sentNudge?.transcript.sessionKey).toBe(
      "tg:-5297593928:cmp9kwhbf0175209zotr1q9le",
    );
  });

  it("resets consecutive nudge backoff when a new user message appears", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
    const state = makeState();
    await evaluateSelfNudgeTick({
      settings: enabledSettings,
      transcript: makeTranscript({ mtimeMs: 10_000 }),
      state,
      nowMs: 11_000,
      sendNudgeMessage,
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
      sendNudgeMessage,
      decide: vi.fn(),
    });

    expect(next).toEqual({ nudged: false, nextDelayMs: 500 });
    expect(state.consecutiveNudges).toBe(0);
  });

  it("does nothing when the model decides no nudge is needed", async () => {
    const sendNudgeMessage = makeSendNudgeMessageMock();
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
      sendNudgeMessage,
      decide: vi
        .fn()
        .mockResolvedValue({
          shouldNudge: false,
          statusNudgeMessage: null,
          finalConfidence: 0,
        }),
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(sendNudgeMessage).not.toHaveBeenCalled();
  });

  it("optionally notifies once when the model decides the latest request is final", async () => {
    const notifyFinalDecision = vi
      .fn<(input: FinalDecisionNotice) => Promise<void>>()
      .mockResolvedValue(undefined);
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
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
          {
            role: "user",
            text: "please do x",
            lineIndex: 0,
            timestampMs: Date.UTC(2026, 5, 3, 11, 10),
          },
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

    expect(text).toBe(
      'TURN_FINAL: message "Finished t..." from 11:11 is final',
    );
  });

  it("formats final notices from visible delivery evidence when it differs from private final text", () => {
    const text = buildFinalDecisionNoticeText({
      transcript: makeTranscript({
        messages: [
          {
            role: "user",
            text: "please do x",
            lineIndex: 0,
            timestampMs: Date.UTC(2026, 5, 3, 11, 10),
          },
          {
            role: "assistant",
            text: "Private final text.",
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
      visibleFinality: {
        visibleText: "Visible Telegram answer.",
        deliveredAtMs: Date.UTC(2026, 5, 3, 11, 13),
        deliveryKind: "final",
      },
      nowMs: Date.UTC(2026, 5, 3, 11, 14),
    });

    expect(text).toBe(
      'TURN_FINAL: message "Visible Te..." from 11:13 is final',
    );
  });

  it("does not use a previous relay final notice as the final assistant preview", () => {
    const text = buildFinalDecisionNoticeText({
      transcript: makeTranscript({
        messages: [
          {
            role: "user",
            text: "please do x",
            lineIndex: 0,
            timestampMs: Date.UTC(2026, 5, 3, 11, 10),
          },
          {
            role: "assistant",
            text: "Finished the deployment and checks.",
            lineIndex: 1,
            timestampMs: Date.UTC(2026, 5, 3, 11, 11),
          },
          {
            role: "assistant",
            text: 'FINAL(100%): message "Finished t..." from 11:11 is final',
            lineIndex: 2,
            timestampMs: Date.UTC(2026, 5, 3, 11, 12),
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
        finalConfidence: 100,
        reasonCode: "final_answer",
      },
      nowMs: Date.UTC(2026, 5, 3, 11, 13),
    });

    expect(text).toBe(
      'TURN_FINAL: message "Finished t..." from 11:11 is final',
    );
  });

  it("formats nudge debug notices with final confidence and decision context", () => {
    const text = buildNudgeDecisionNoticeText({
      transcript: makeTranscript({
        messages: [
          {
            role: "user",
            text: "Please deploy the release and confirm all checks are green.",
            lineIndex: 0,
          },
          {
            role: "assistant",
            text: "I pushed the change, but deployment remains.",
            lineIndex: 1,
          },
        ],
        latestUserMessage: {
          role: "user",
          text: "Please deploy the release and confirm all checks are green.",
          lineIndex: 0,
        },
      }),
      decision: {
        shouldNudge: true,
        statusNudgeMessage: "Continue deployment.",
        finalConfidence: 42,
      },
      messageText: "[STATUS_NUDGE]\nContinue deployment.",
      nowMs: Date.UTC(2026, 5, 3, 11, 12),
    });

    expect(text).toBe(
      'NUDGE(42% final): latest user "Please deploy the release and confirm all checks..." assistant "I pushed the change, but deployment remains."\n[STATUS_NUDGE]\nContinue deployment.',
    );
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
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
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-index-"),
    );
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
      processedStore: createFileSelfNudgeProcessedStore({ stateDir }),
      notifyFinalDecision: afterRestartNotice,
      decide: afterRestartDecision,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(afterRestartDecision).not.toHaveBeenCalled();
    expect(afterRestartNotice).not.toHaveBeenCalled();
  });

  it("dedupes final notices when runtime history line indexes shift", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gwr-nudge-runtime-index-"),
    );
    const store = createFileSelfNudgeProcessedStore({ stateDir });
    const settings: RelaySelfNudgeSettings = {
      ...enabledSettings,
      finalNoticeEnabled: true,
    };
    const userTimestampMs = Date.UTC(2026, 5, 9, 6, 58, 24);
    const firstTranscript = makeTranscript({
      mtimeMs: userTimestampMs + 1_000,
      messages: [
        {
          role: "user",
          text: "как дела?",
          lineIndex: 96,
          timestampMs: userTimestampMs,
        },
        {
          role: "assistant",
          text: "Нормально. Релиз завершен.",
          lineIndex: 97,
          timestampMs: userTimestampMs + 1_000,
        },
      ],
      latestUserMessage: {
        role: "user",
        text: "как дела?",
        lineIndex: 96,
        timestampMs: userTimestampMs,
      },
    });

    await evaluateSelfNudgeTick({
      settings,
      transcript: firstTranscript,
      state: makeState(),
      nowMs: userTimestampMs + 10 * 60_000,
      sendNudgeMessage: makeSendNudgeMessageMock(),
      processedStore: store,
      notifyFinalDecision: vi.fn().mockResolvedValue(undefined),
      decide: vi.fn().mockResolvedValue({
        shouldNudge: false,
        statusNudgeMessage: null,
        finalConfidence: 100,
        reasonCode: "final_answer",
      }),
    });

    const shiftedDecision = vi.fn().mockResolvedValue({
      shouldNudge: false,
      statusNudgeMessage: null,
      finalConfidence: 100,
      reasonCode: "final_answer",
    });
    const shiftedNotice = vi.fn().mockResolvedValue(undefined);
    const result = await evaluateSelfNudgeTick({
      settings,
      transcript: {
        ...firstTranscript,
        mtimeMs: userTimestampMs + 11 * 60_000,
        messages: firstTranscript.messages.map((message) => ({
          ...message,
          lineIndex: message.lineIndex - 2,
        })),
        latestUserMessage: {
          ...firstTranscript.latestUserMessage!,
          lineIndex: 94,
        },
      },
      state: makeState(),
      nowMs: userTimestampMs + 20 * 60_000,
      sendNudgeMessage: makeSendNudgeMessageMock(),
      processedStore: createFileSelfNudgeProcessedStore({ stateDir }),
      notifyFinalDecision: shiftedNotice,
      decide: shiftedDecision,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(shiftedDecision).not.toHaveBeenCalled();
    expect(shiftedNotice).not.toHaveBeenCalled();
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
      sendNudgeMessage: makeSendNudgeMessageMock(),
      notifyFinalDecision,
      decide,
    });

    expect(result).toEqual({ nudged: false, nextDelayMs: 1_000 });
    expect(decide).not.toHaveBeenCalled();
    expect(notifyFinalDecision).not.toHaveBeenCalled();
  });

  it("always formats the same fixed status nudge message", () => {
    expect(formatStatusNudgeMessage("[STATUS_NUDGE]\nContinue.")).toBe(
      STATUS_NUDGE_MESSAGE,
    );
    expect(formatStatusNudgeMessage("Invent a different requirement.")).toBe(
      STATUS_NUDGE_MESSAGE,
    );
  });

  it("uses the configured OpenRouter provider proxy path for analysis", () => {
    expect(
      buildOpenRouterProxyChatCompletionsUrl({
        port: 18080,
        pathPrefix: "/provider-proxy/openrouter/",
      }),
    ).toBe(
      "http://127.0.0.1:18080/provider-proxy/openrouter/api/v1/chat/completions",
    );
  });
});
