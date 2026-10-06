import fs from "node:fs/promises";
import path from "node:path";

export type RuntimeWorkloadReason = {
  kind: "OPENCLAW_CHILD_PROCESS" | "CODEX_PROCESS";
  processId: number;
  parentProcessId: number;
  executable: string;
};

export type RuntimeWorkloadSnapshot = {
  probeVersion: 1;
  complete: true;
  gatewayProcessFound: true;
  busy: boolean;
  reasons: RuntimeWorkloadReason[];
};

type ProcessSnapshot = {
  processId: number;
  parentProcessId: number;
  state: string;
  argv: string[];
};

function isProcessRace(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ESRCH";
}

function parseProcessStat(raw: string): Pick<ProcessSnapshot, "parentProcessId" | "state"> {
  const closingParen = raw.lastIndexOf(")");
  if (closingParen < 0) {
    throw new Error("Invalid /proc process stat payload");
  }
  const fields = raw.slice(closingParen + 1).trim().split(/\s+/u);
  const state = fields[0];
  const parentProcessId = Number(fields[1]);
  if (!state || !Number.isInteger(parentProcessId) || parentProcessId < 0) {
    throw new Error("Invalid /proc process state or parent process id");
  }
  return { state, parentProcessId };
}

async function readProcessSnapshot(procRoot: string, processId: number): Promise<ProcessSnapshot | null> {
  try {
    const [stat, cmdline] = await Promise.all([
      fs.readFile(path.join(procRoot, String(processId), "stat"), "utf8"),
      fs.readFile(path.join(procRoot, String(processId), "cmdline")),
    ]);
    const parsedStat = parseProcessStat(stat);
    const argv = cmdline
      .toString("utf8")
      .split("\0")
      .filter((value) => value.length > 0);
    return { processId, ...parsedStat, argv };
  } catch (error) {
    if (isProcessRace(error)) return null;
    throw error;
  }
}

function isOpenclawGateway(process: ProcessSnapshot): boolean {
  // Managed launcher repair and installed-package services use different entry
  // paths. Match the actual executable/script slot, never a shell command,
  // prompt or unrelated argument containing an OpenClaw path. This is workload
  // discovery only; it grants no model/owner/config authority.
  const node = /^node(?:\.exe)?$/u.test(path.basename(process.argv[0] ?? ""));
  const entryIndex = node ? 1 : 0;
  const entry = process.argv[entryIndex] ?? "";
  const installedEntry = entry.endsWith("/openclaw/dist/index.js")
    || entry.endsWith("/openclaw/openclaw.mjs");
  const managedLauncher = entry === "/usr/local/bin/openclaw" || entry === "/usr/bin/openclaw";
  return (installedEntry || managedLauncher)
    && process.argv[entryIndex + 1] === "gateway";
}

function codexExecutable(process: ProcessSnapshot): string | null {
  const executableCandidates = process.argv.slice(0, 2).map((value) => path.basename(value));
  return executableCandidates.includes("codex") ? "codex" : null;
}

function sanitizedExecutable(process: ProcessSnapshot): string {
  const executable = process.argv[0] ? path.basename(process.argv[0]) : "unknown";
  return executable.slice(0, 80) || "unknown";
}

function collectDescendants(processes: ProcessSnapshot[], roots: Set<number>): Set<number> {
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.processId) || roots.has(process.processId)) continue;
      if (roots.has(process.parentProcessId) || descendants.has(process.parentProcessId)) {
        descendants.add(process.processId);
        changed = true;
      }
    }
  }
  return descendants;
}

export async function readRuntimeWorkloadSnapshot(
  options: { procRoot?: string } = {},
): Promise<RuntimeWorkloadSnapshot> {
  const procRoot = options.procRoot ?? "/proc";
  const entries = await fs.readdir(procRoot, { withFileTypes: true });
  const processIds = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => Number(entry.name));
  const snapshots = await Promise.all(
    processIds.map((processId) => readProcessSnapshot(procRoot, processId)),
  );
  const processes = snapshots.filter((process): process is ProcessSnapshot => process !== null);
  const gatewayProcessIds = new Set(
    processes.filter(isOpenclawGateway).map((process) => process.processId),
  );
  if (gatewayProcessIds.size === 0) {
    throw new Error("RUNTIME_WORKLOAD_GATEWAY_NOT_FOUND");
  }
  // The managed launcher can respawn the server with a rewritten process title.
  // Only its DIRECT titled child joins the root set. An unrelated titled process
  // or a tool beneath the actual server must never disappear from workload.
  const launcherProcessIds = new Set(gatewayProcessIds);
  for (const process of processes) {
    if (launcherProcessIds.has(process.parentProcessId)
      && process.argv.length === 1 && process.argv[0] === "openclaw-gateway") {
      gatewayProcessIds.add(process.processId);
    }
  }
  const gatewayDescendants = collectDescendants(processes, gatewayProcessIds);
  const reasons: RuntimeWorkloadReason[] = [];
  for (const process of processes) {
    if (process.state === "Z") continue;
    const codex = codexExecutable(process);
    if (codex) {
      reasons.push({
        kind: "CODEX_PROCESS",
        processId: process.processId,
        parentProcessId: process.parentProcessId,
        executable: codex,
      });
      continue;
    }
    if (gatewayDescendants.has(process.processId)) {
      reasons.push({
        kind: "OPENCLAW_CHILD_PROCESS",
        processId: process.processId,
        parentProcessId: process.parentProcessId,
        executable: sanitizedExecutable(process),
      });
    }
  }
  reasons.sort((left, right) => left.processId - right.processId);
  return {
    probeVersion: 1,
    complete: true,
    gatewayProcessFound: true,
    busy: reasons.length > 0,
    reasons,
  };
}
