import { describe, expect, it } from "vitest";
import { loadRelayConfig } from "./env.js";

describe("loadRelayConfig", () => {
  it("requires RELAY_TOKEN and BACKEND_BASE_URL", () => {
    expect(() =>
      loadRelayConfig({
        RELAY_TOKEN: "t",
        BACKEND_BASE_URL: "https://example.com",
      })
    ).not.toThrow();
  });
});

