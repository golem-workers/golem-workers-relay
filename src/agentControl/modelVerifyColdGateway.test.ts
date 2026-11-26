import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
import { GatewayClient } from "../openclaw/gatewayClient.js";
import { executeAgentControl } from "./executeAgentControl.js";
import * as probe from "./modelVerificationProbe.js";

it.each(["pre-inference", "post-inference"])("accepts a successful 16,882ms %s session RPC without replaying inference", async phase => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-verify-cold-"));
  const configPath = path.join(dir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ agents: { defaults: { model: { primary: "openrouter/openai/gpt-6-luna", fallbacks: [] } } } }));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(dir, "state"));
  const proof = vi.spyOn(probe, "runIsolatedModelProbe").mockImplementation(input => Promise.resolve({ status: "ok", result: { payloads: [{ text: input.messageText.split(" ")[2].slice(0, -1) }], meta: { agentMeta: { provider: "openrouter", model: "openai/gpt-6-luna", agentHarnessId: "openclaw" } } } }));
  const server = new WebSocketServer({ port: 0 });
  let patches = 0;
  const methods: string[] = [];
  let delayed: ReturnType<typeof setTimeout> | undefined;
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "cold-gateway", ts: 1 } }));
    socket.on("message", data => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
      const request = JSON.parse(text) as { id: string; method: string };
      methods.push(request.method);
      const send = (payload: unknown) => socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload }));
      if (request.method === "connect") send({ type: "hello-ok", protocol: 3, policy: { tickIntervalMs: 30_000 } });
      else if (request.method === "sessions.patch") {
        const response = { resolved: { modelProvider: "openrouter", model: "openai/gpt-6-luna", agentRuntime: { id: "openclaw", source: "default" } }, entry: patches === 0 ? {} : { modelProvider: "openrouter", model: "openai/gpt-6-luna", agentHarnessId: "openclaw" } };
        if (patches++ === (phase === "pre-inference" ? 0 : 1)) delayed = setTimeout(() => send(response), 16_882);
        else send(response);
      } else send({});
    });
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("No test port");
  const gateway = new GatewayClient({ url: `ws://127.0.0.1:${address.port}` });
  try {
    await gateway.start();
    await expect(executeAgentControl({ configPath, gateway, statusNudgeRunner: { runChatTask: vi.fn() }, action: { kind: "model.verify", model: "openrouter/openai/gpt-6-luna" } })).resolves.toMatchObject({ verified: true });
    expect(proof).toHaveBeenCalledOnce();
    expect(methods).toEqual(["connect", "sessions.patch", "sessions.patch", "sessions.delete"]);
  } finally {
    if (delayed) clearTimeout(delayed);
    gateway.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 30_000);
