import { describe, expect, it } from "vitest";
import { agentControlActionSchema } from "./protocol.js";
describe("reasoning transport", () => {
  it.each(["max", "adaptive", "ultra"])("accepts %s in model and assignment commands", thinkingDefault => {
    expect(agentControlActionSchema.parse({ kind: "model.set", model: "openai/gpt-6-astra", fallbacks: [], thinkingDefault })).toHaveProperty("thinkingDefault", thinkingDefault);
    expect(agentControlActionSchema.parse({ kind: "modelAssignment.set", purpose: "main", primary: "openai/gpt-6-astra", fallback: null, thinkingDefault })).toHaveProperty("thinkingDefault", thinkingDefault);
  });
});
