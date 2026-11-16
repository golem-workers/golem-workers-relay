import { expect, it } from "vitest";
import { clearSubscriptionModelFallbacks } from "./subscriptionModelFallbacks.js";
it("clears model assignments only, including nested/subagent/cron and auxiliary assignments", () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: "openai/main", fallbacks: ["paid/model"] },
        subagents: {
          model: { primary: "openai/child", fallbacks: ["paid/child"] },
        },
        imageModel: { primary: "openai/image", fallback: "paid/image" },
        memorySearch: { fallback: "none" },
        thinkingDefault: "high",
      },
      list: [
        {
          id: "child",
          model: { primary: "openai/child", fallbacks: ["paid/other"] },
        },
      ],
    },
    cron: {
      jobs: [{ payload: { kind: "agentTurn", fallbacks: ["paid/cron"] } }],
    },
    plugins: { entries: { codex: { config: { fallback: "openclaw" } } } },
    channels: { fallback: "keep" },
  };
  const before = structuredClone(config),
    next = clearSubscriptionModelFallbacks(config) as typeof config;
  expect(config).toEqual(before);
  expect(next.agents.defaults.model).toEqual({
    primary: "openai/main",
    fallbacks: [],
  });
  expect(next.agents.defaults.subagents.model).toEqual({
    primary: "openai/child",
    fallbacks: [],
  });
  expect(next.agents.defaults.imageModel).toEqual({ primary: "openai/image" });
  expect(next.agents.list[0].model.fallbacks).toEqual([]);
  expect(next.cron.jobs[0].payload.fallbacks).toEqual([]);
  expect(next.agents.defaults.memorySearch).toEqual(
    before.agents.defaults.memorySearch,
  );
  expect(next.agents.defaults.thinkingDefault).toBe("high");
  expect(next.plugins).toEqual(before.plugins);
  expect(next.channels).toEqual(before.channels);
});
