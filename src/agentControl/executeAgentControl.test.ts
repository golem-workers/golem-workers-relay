import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAgentControl } from "./executeAgentControl.js";

const noopGateway = {
  request: () => {
    throw new Error("gateway should not be called");
  },
};

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

async function createTempStateDir() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-pairing-"));
  const stateDir = path.join(tempDir, ".openclaw");
  const credentialsDir = path.join(stateDir, "credentials");
  await fs.mkdir(credentialsDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { tempDir, stateDir, credentialsDir };
}

describe("executeAgentControl channel pairing", () => {
  it("lists pending telegram pairing requests from the OpenClaw pairing store", async () => {
    const { credentialsDir } = await createTempStateDir();
    await fs.writeFile(
      path.join(credentialsDir, "telegram-pairing.json"),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: "449985919",
            code: "ABCD2345",
            createdAt: "2026-04-08T15:00:00.000Z",
            meta: {
              username: "belbix",
              accountId: "default",
            },
          },
        ],
      }),
      "utf8"
    );

    const result = await executeAgentControl({
      action: { kind: "channelPairing.list", channel: "telegram" },
      configPath: path.join(credentialsDir, "..", "openclaw.json"),
      gateway: noopGateway,
    });

    expect(result).toEqual({
      kind: "channelPairing.list",
      requests: [
        {
          id: "449985919",
          code: "ABCD2345",
          createdAt: "2026-04-08T15:00:00.000Z",
          meta: {
            username: "belbix",
            accountId: "default",
          },
        },
      ],
    });
  });

  it("approves telegram pairing requests and appends the sender to allowFrom", async () => {
    const { credentialsDir } = await createTempStateDir();
    await fs.writeFile(
      path.join(credentialsDir, "telegram-pairing.json"),
      JSON.stringify({
        version: 1,
        requests: [
          {
            id: "449985919",
            code: "ABCD2345",
            createdAt: "2026-04-08T15:00:00.000Z",
            meta: {
              username: "belbix",
              accountId: "default",
            },
          },
        ],
      }),
      "utf8"
    );

    const result = await executeAgentControl({
      action: { kind: "channelPairing.approve", channel: "telegram", code: "ABCD2345" },
      configPath: path.join(credentialsDir, "..", "openclaw.json"),
      gateway: noopGateway,
    });

    const pairingStore = JSON.parse(
      await fs.readFile(path.join(credentialsDir, "telegram-pairing.json"), "utf8")
    ) as { requests: unknown[] };
    const allowFromStore = JSON.parse(
      await fs.readFile(path.join(credentialsDir, "telegram-default-allowFrom.json"), "utf8")
    ) as { allowFrom: string[] };

    expect(result).toEqual({
      kind: "channelPairing.approve",
      approved: true,
      payload: {
        id: "449985919",
        code: "ABCD2345",
        entry: {
          id: "449985919",
          code: "ABCD2345",
          createdAt: "2026-04-08T15:00:00.000Z",
          meta: {
            username: "belbix",
            accountId: "default",
          },
        },
      },
    });
    expect(pairingStore.requests).toEqual([]);
    expect(allowFromStore.allowFrom).toEqual(["449985919"]);
  });
});
