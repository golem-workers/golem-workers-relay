import { describe, it, expect } from "vitest";
import { ensureNativePiModelCompatibility } from "./nativePiModelCompatibility.js";
describe("native GPT-6.1-Sol catalog compatibility", () => {
  it.each([[true, "openai-chatgpt-responses"], [false, "openai-responses"]] as const)("preserves route identity subscription=%s", (subscription, api) => {
    const cfg = { agents: { defaults: { models: { "openai/gpt-6.1-sol": { agentRuntime: { id: "openclaw" } } } } } };
    ensureNativePiModelCompatibility(cfg, subscription);
    expect(cfg).toMatchObject({ models: { providers: { openai: { models: [{ id: "gpt-6.1-sol", api, contextWindow: 272000, agentRuntime: { id: "openclaw" } }] } } } });
    const once = structuredClone(cfg);
    ensureNativePiModelCompatibility(cfg, subscription);
    expect(cfg).toEqual(once);
  });
  it("leaves unrelated models alone and preserves authored metadata and credentials", () => {
    const empty = { agents: { defaults: { models: { "openai/gpt-6-astra": {} } } } };
    const before = structuredClone(empty);
    ensureNativePiModelCompatibility(empty, true);
    expect(empty).toEqual(before);
    const cfg = { agents: { defaults: { models: { "openai/gpt-6.1-sol": {} } } }, models: { providers: { openai: { baseUrl: "https://example.test", apiKey: "preserved-ref", models: [{ id: "gpt-6.1-sol", api: "openai-responses", contextWindow: 123456 }] } } } };
    ensureNativePiModelCompatibility(cfg, true);
    expect(cfg.models.providers.openai).toMatchObject({ baseUrl: "https://example.test", apiKey: "preserved-ref", models: [{ api: "openai-responses", contextWindow: 123456 }] });
  });
});
