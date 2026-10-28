import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/prepare-agent-server.sh");
const script = readFileSync(scriptPath, "utf8");

function runVersionCheck(version: string) {
  const scriptWithoutMain = script.replace(/\nmain "\$@"\s*$/, "");
  return spawnSync("bash", ["-s", "--", version], {
    encoding: "utf8",
    input: `${scriptWithoutMain}\nnode_meets_openclaw_floor "$1"\n`
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

function patchGatewayUnit(unit: string) {
  const tempDir = mkdtempSync(resolve(tmpdir(), "openclaw-gateway-unit-"));
  const unitPath = resolve(tempDir, "openclaw-gateway.service");
  writeFileSync(unitPath, unit);
  const scriptWithoutMain = script.replace(/\nmain "\$@"\s*$/, "");
  const result = spawnSync("bash", ["-s", "--", unitPath], {
    encoding: "utf8",
    input: `${scriptWithoutMain}\nconfigure_openclaw_gateway_snapshot_heap "$1"\n`,
  });
  const patched = readFileSync(unitPath, "utf8");
  rmSync(tempDir, { recursive: true, force: true });
  return { result, patched };
}

describe("prepare-agent-server.sh", () => {
  it("clears obsolete native mode overrides before snapshot commands", () => {
    const result = spawnSync("bash", ["-s"], {
      encoding: "utf8",
      env: { ...process.env, FS_SAFE_NATIVE_MODE: "require", OPENCLAW_FS_SAFE_NATIVE_MODE: "auto" },
      input: `${script.replace(/\nmain "\$@"\s*$/, "")}\nprintf '%s:%s' "\${FS_SAFE_NATIVE_MODE:-}" "\${OPENCLAW_FS_SAFE_NATIVE_MODE:-}"\n`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(":");
  });

  it("clears obsolete native overrides for relay subprocesses on existing agents", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "relay-portable-fs-"));
    const npm = resolve(dir, "npm");
    writeFileSync(npm, '#!/bin/sh\nprintf "%s:%s:%s" "${FS_SAFE_NATIVE_MODE:-}" "${OPENCLAW_FS_SAFE_NATIVE_MODE:-}" "$*"\n', { mode: 0o755 });
    try {
      const result = spawnSync("bash", [resolve(process.cwd(), "scripts/start.sh")], {
        encoding: "utf8",
        env: { ...process.env, NPM_BIN: npm, FS_SAFE_NATIVE_MODE: "require", OPENCLAW_FS_SAFE_NATIVE_MODE: "auto" },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("::run start");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses npm-owned launchers without installing pnpm or linking a launcher onto itself", () => {
    expect(script).toContain('export npm_config_prefix=/usr/local');
    expect(script).toContain('npm config set prefix /usr/local --location=user');
    expect(script).toContain('GLOBAL_NPM_ROOT="$(npm root -g)"');
    expect(script).toContain('npm install -g "@openai/codex@${CODEX_INSTALL_VERSION}"');
    expect(script).toContain('test -x /usr/local/bin/openclaw');
    expect(script).not.toContain('pnpm');
    expect(script).not.toContain('ln -sfn "${GLOBAL_NPM_ROOT}');
  });

  it("retains the actual global dependency tree and Node checksum in baked images", () => {
    expect(script).toContain("/var/lib/golem-workers/managed-global-dependencies.json");
    expect(script).toContain("/var/lib/golem-workers/node-runtime.sha256");
    expect(script).toContain('companion_specs+=("${companion}@${resolved_companion}")');
    expect(script).toContain('"${companion_specs[@]}"');
  });

  it("enforces the Node ranges required by current OpenClaw releases", () => {
    for (const version of ["v24.22.1", "v24.23.1", "24.22.1"]) {
      expect(runVersionCheck(version).status, version).toBe(0);
    }

    for (const version of ["v24.22.0", "v24.22.1-rc.1", "v25.99.99", "v26.1.0", "v27.0.0", "v24.16", "invalid", ""]) {
      expect(runVersionCheck(version).status, version || "empty version").not.toBe(0);
    }

    expect(script).toContain('OPENCLAW_MIN_NODE_24_VERSION="24.22.1"');
    expect(script).toContain("https://deb.nodesource.com/setup_24.x");
    expect(script).toContain("install_openclaw_nodejs");
    expect(script).toContain('hash -r');
    expect(script).toContain('if ! node_meets_openclaw_floor "${installed_node_version}"; then');
  });

  it("upgrades an old Node patch and rejects an insufficient installed result", () => {
    const upgraded = runInstall("v22.22.3", "v24.22.1");
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain("installed:v24.22.1");

    const insufficient = runInstall("v22.22.3", "v24.15.9");
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain(
      "Node.js 24.22.1+ on major 24 is required; got v24.15.9"
    );
  });

  it("raises both inline and environment gateway heap limits before readiness recovery", () => {
    const inline = patchGatewayUnit(
      "[Service]\nExecStart=/usr/bin/node --max-old-space-size=178 /opt/openclaw gateway\n"
    );
    expect(inline.result.status).toBe(0);
    expect(inline.patched).toContain(
      'Environment="NODE_OPTIONS=--max-old-space-size=768 --enable-source-maps"'
    );
    expect(inline.patched).toContain("ExecStart=/usr/bin/node --max-old-space-size=768");
    expect(inline.patched).not.toContain("--max-old-space-size=178");

    const environment = patchGatewayUnit(
      '[Service]\nEnvironment="NODE_OPTIONS=--max-old-space-size=256 --enable-source-maps"\nExecStart=/usr/bin/node /opt/openclaw gateway\n'
    );
    expect(environment.result.status).toBe(0);
    expect(environment.patched.match(/Environment="NODE_OPTIONS=/g)).toHaveLength(1);
    expect(environment.patched).toContain("--max-old-space-size=768");
    expect(environment.patched).not.toContain("--max-old-space-size=256");
  });
});

describe("agent Docker preparation", () => {
  function runDockerInstall(kernel: string, controllers: string) {
    const withoutMain = script.replace(/\nmain "\$@"\s*$/, "");
    return spawnSync("bash", ["-s"], {
      encoding: "utf8",
      input: `${withoutMain}
uname() { printf '%s\\n' '${kernel}'; }
grep() { case "$2" in cpu|cpuset|memory|pids) [[ ' ${controllers} ' == *" $2 "* ]];; *) command grep "$@";; esac; }
apt-get() { printf 'APT:%s\\n' "$*"; }
systemctl() { printf 'SYSTEMCTL:%s\\n' "$*"; }
docker() { printf 'DOCKER:%s\\n' "$*"; }
install_agent_docker
`,
    });
  }

  it("rejects the old quickstart kernel before installing packages", () => {
    const result = runDockerInstall("4.14.174", "cpu cpuset memory pids");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Update BASE_KERNEL_PATH and cold boot");
    expect(result.stdout).not.toContain("APT:");
  });

  it("rejects missing container cgroup controllers", () => {
    const result = runDockerInstall("6.1.190-golem-docker1", "memory pids");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("missing cgroup v2 controller: cpu");
    expect(result.stdout).not.toContain("APT:");
  });

  it("installs Engine and Compose and enables persistent daemon startup", () => {
    const result = runDockerInstall("6.1.190-golem-docker1", "cpu cpuset memory pids");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("APT:install -y docker.io docker-compose-v2 docker-buildx");
    expect(result.stdout).toContain("SYSTEMCTL:enable --now docker.service");
    expect(result.stdout).toContain("DOCKER:compose version");
    expect(result.stdout).toContain("DOCKER:buildx version");
  });
});
