import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeWorkloadSnapshot } from "./runtimeWorkload.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createProcRoot() {
  const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gw-relay-proc-"));
  tempDirs.push(procRoot);
  return procRoot;
}

async function writeProcess(input: {
  procRoot: string;
  processId: number;
  parentProcessId: number;
  state?: string;
  argv: string[];
}) {
  const processDir = path.join(input.procRoot, String(input.processId));
  await fs.mkdir(processDir);
  await fs.writeFile(
    path.join(processDir, "stat"),
    `${input.processId} (process) ${input.state ?? "S"} ${input.parentProcessId} 0 0 0\n`,
    "utf8",
  );
  await fs.writeFile(path.join(processDir, "cmdline"), `${input.argv.join("\0")}\0`, "utf8");
}

describe("readRuntimeWorkloadSnapshot", () => {
  it("does not count a launcher's directly respawned Gateway itself as busy", async () => {
    const procRoot = await createProcRoot();
    await writeProcess({ procRoot, processId: 100, parentProcessId: 1, argv: ["node", "/usr/local/bin/openclaw", "gateway"] });
    await writeProcess({ procRoot, processId: 101, parentProcessId: 100, argv: ["openclaw-gateway"] });
    expect((await readRuntimeWorkloadSnapshot({ procRoot })).busy).toBe(false);
    await writeProcess({ procRoot, processId: 102, parentProcessId: 101, argv: ["openclaw-gateway"] });
    const busy = await readRuntimeWorkloadSnapshot({ procRoot });
    expect(busy.busy).toBe(true);
    expect(busy.reasons.map(reason => reason.processId)).toEqual([102]);
  });

  it("does not trust a standalone rewritten Gateway title without its launcher", async () => {
    const procRoot = await createProcRoot();
    await writeProcess({ procRoot, processId: 100, parentProcessId: 1, argv: ["openclaw-gateway"] });
    await expect(readRuntimeWorkloadSnapshot({ procRoot })).rejects.toThrow("RUNTIME_WORKLOAD_GATEWAY_NOT_FOUND");
  });

  it.each([
    ["node", "/usr/local/bin/openclaw", "gateway", "--port", "18789"],
    ["/opt/node-v24.16.0/bin/node", "/usr/bin/openclaw", "gateway"],
    ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"],
    ["/usr/local/bin/openclaw", "gateway"],
  ])("recognizes the managed or installed launcher %j without losing descendants", async (...argv) => {
    const procRoot = await createProcRoot();
    await writeProcess({ procRoot, processId: 100, parentProcessId: 1, argv });
    await writeProcess({ procRoot, processId: 101, parentProcessId: 100, argv: ["/usr/bin/bash", "-c", "private tool command"] });
    const result = await readRuntimeWorkloadSnapshot({ procRoot });
    expect(result.gatewayProcessFound).toBe(true);
    expect(result.busy).toBe(true);
    expect(result.reasons).toEqual([{ kind: "OPENCLAW_CHILD_PROCESS", processId: 101, parentProcessId: 100, executable: "bash" }]);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([
    ["/usr/bin/bash", "-c", "node /usr/local/bin/openclaw gateway"],
    ["/usr/bin/node", "/tmp/probe.js", "/opt/openclaw/dist/index.js", "gateway"],
    ["node", "/usr/local/bin/openclaw", "doctor", "gateway"],
    ["node", "/usr/local/bin/openclaw-fake", "gateway"],
  ])("refuses unrelated arguments or non-Gateway commands %j", async (...argv) => {
    const procRoot = await createProcRoot();
    await writeProcess({ procRoot, processId: 100, parentProcessId: 1, argv });
    await expect(readRuntimeWorkloadSnapshot({ procRoot })).rejects.toThrow("RUNTIME_WORKLOAD_GATEWAY_NOT_FOUND");
  });

  it("reports an idle gateway as a complete non-busy observation", async () => {
    const procRoot = await createProcRoot();
    await writeProcess({
      procRoot,
      processId: 100,
      parentProcessId: 1,
      argv: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway", "--port", "18789"],
    });

    await expect(readRuntimeWorkloadSnapshot({ procRoot })).resolves.toEqual({
      probeVersion: 1,
      complete: true,
      gatewayProcessFound: true,
      busy: false,
      reasons: [],
    });
  });

  it("reports OpenClaw descendants and standalone Codex without exposing command arguments", async () => {
    const procRoot = await createProcRoot();
    await writeProcess({
      procRoot,
      processId: 100,
      parentProcessId: 1,
      argv: ["/usr/bin/node", "/opt/openclaw/dist/index.js", "gateway", "--port", "18789"],
    });
    await writeProcess({
      procRoot,
      processId: 101,
      parentProcessId: 100,
      argv: ["/usr/bin/bash", "-c", "secret tool command"],
    });
    await writeProcess({
      procRoot,
      processId: 102,
      parentProcessId: 101,
      argv: ["/usr/bin/python3", "-c", "secret child command"],
    });
    await writeProcess({
      procRoot,
      processId: 200,
      parentProcessId: 50,
      argv: ["/usr/bin/node", "/usr/local/bin/codex", "exec", "secret prompt"],
    });

    const result = await readRuntimeWorkloadSnapshot({ procRoot });

    expect(result.busy).toBe(true);
    expect(result.reasons).toEqual([
      {
        kind: "OPENCLAW_CHILD_PROCESS",
        processId: 101,
        parentProcessId: 100,
        executable: "bash",
      },
      {
        kind: "OPENCLAW_CHILD_PROCESS",
        processId: 102,
        parentProcessId: 101,
        executable: "python3",
      },
      {
        kind: "CODEX_PROCESS",
        processId: 200,
        parentProcessId: 50,
        executable: "codex",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails closed when the OpenClaw gateway process is absent", async () => {
    const procRoot = await createProcRoot();
    await writeProcess({
      procRoot,
      processId: 200,
      parentProcessId: 1,
      argv: ["/usr/bin/node", "/usr/local/bin/codex", "exec"],
    });

    await expect(readRuntimeWorkloadSnapshot({ procRoot })).rejects.toThrow(
      "RUNTIME_WORKLOAD_GATEWAY_NOT_FOUND",
    );
  });
});
