import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendClient } from "./backendClient.js";

describe("BackendClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats non-JSON 2xx pull as empty batch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>\n<h1>upstream error</h1>\n</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );

    const client = new BackendClient({
      baseUrl: "https://backend.example.com",
      relayToken: "relay-token",
    });

    const pulled = await client.pull({
      relayInstanceId: "relay-1",
      maxTasks: 1,
      waitSeconds: 0,
    });
    expect(pulled).toEqual({ tasks: [] });

    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry for status 200
  });
});
