import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/prepare-agent-server.sh");
const script = readFileSync(scriptPath, "utf8");

function runVersionCheck(version: string) {
  const scriptWithoutMain = script.replace(/\nmain "\$@"\s*$/, "");
  return spawnSync("bash", ["-s", "--", version], {
    encoding: "utf8",
    input: `${scriptWithoutMain}\nnode_22_meets_openclaw_floor "$1"\n`
  });
}

function runInstall(initialVersion: string, installedVersion: string) {
  const scriptWithoutMain = script.replace(/\nmain "\$@"\s*$/, "");
  return spawnSync("bash", ["-s", "--", initialVersion, installedVersion], {
    encoding: "utf8",
    input: `${scriptWithoutMain}
NODE_VERSION="$1"
INSTALL_VERSION="$2"
node() { printf '%s\\n' "$NODE_VERSION"; }
curl() { printf 'setup\\n'; }
bash() { cat >/dev/null; }
apt-get() { NODE_VERSION="$INSTALL_VERSION"; }
install_openclaw_nodejs
printf 'installed:%s\\n' "$NODE_VERSION"
`
  });
}

describe("prepare-agent-server.sh", () => {
  it("links stable OpenClaw and Codex commands to package bin entries instead of pnpm shims", () => {
    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/codex" /usr/local/bin/codex');
    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/openclaw" /usr/local/bin/openclaw');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/codex" /usr/local/bin/codex');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/openclaw" /usr/local/bin/openclaw');
  });

  it("enforces the OpenClaw Node 22.22.3 patch floor", () => {
    for (const version of ["v22.22.3", "v22.23.1", "22.22.3"]) {
      expect(runVersionCheck(version).status, version).toBe(0);
    }

    for (const version of ["v22.22.2", "v21.99.99", "v23.0.0", "v22.22", "invalid", ""]) {
      expect(runVersionCheck(version).status, version || "empty version").not.toBe(0);
    }

    expect(script).toContain('OPENCLAW_MIN_NODE_VERSION="22.22.3"');
    expect(script).toContain("install_openclaw_nodejs");
    expect(script).toContain('hash -r');
    expect(script).toContain('if ! node_22_meets_openclaw_floor "${installed_node_version}"; then');
  });

  it("upgrades an old Node patch and rejects an insufficient installed result", () => {
    const upgraded = runInstall("v22.22.2", "v22.22.3");
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain("installed:v22.22.3");

    const insufficient = runInstall("v22.22.2", "v22.22.2");
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain(
      "Node.js 22.22.3+ on major 22 is required; got v22.22.2"
    );
  });
});
