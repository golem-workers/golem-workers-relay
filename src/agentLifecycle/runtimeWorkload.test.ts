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
