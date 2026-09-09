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
  it("links stable OpenClaw and Codex commands to package bin entries instead of pnpm shims", () => {
    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/codex" /usr/local/bin/codex');
    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/openclaw" /usr/local/bin/openclaw');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/codex" /usr/local/bin/codex');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/openclaw" /usr/local/bin/openclaw');
  });

  it("preinstalls the pinned Sidewisp observation plugin without enrollment credentials", () => {
    expect(script).toContain('SIDEWISP_PLUGIN_VERSION="0.2.18"');
    expect(script).toContain(
      'SIDEWISP_PLUGIN_SPEC="${SIDEWISP_PLUGIN_SPEC:-git:github.com/golem-workers/sidewisp-plugin@v${SIDEWISP_PLUGIN_VERSION}}"'
    );
    expect(script).toContain('openclaw plugins install --force "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" "${SIDEWISP_PLUGIN_SPEC}"');
    expect(script).toContain('openclaw plugins enable "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" sidewisp');
    expect(script).toContain('SIDEWISP_PLUGIN_ENDPOINT="https://api.sidewisp.com"');
    expect(script).toContain('SIDEWISP_PLUGIN_ENDPOINT="https://staging-api.sidewisp.com"');
    expect(script).toContain(
      'openclaw config set plugins.entries.sidewisp.config.endpoint "${SIDEWISP_PLUGIN_ENDPOINT}"'
    );
    expect(script).toContain('test ! -e /root/.openclaw/sidewisp/installation.json');
    expect(script).toContain(
      'const requiredPluginIds = ["relay-channel", "codex", "whatsapp", "moonshot", "perplexity", "sidewisp"]'
    );
  });

  it("enforces the Node ranges required by current OpenClaw releases", () => {
    for (const version of ["v24.16.0", "v24.17.1", "24.16.0", "v26.1.0", "v27.0.0"]) {
      expect(runVersionCheck(version).status, version).toBe(0);
    }

    for (const version of ["v24.15.9", "v25.99.99", "v26.0.9", "v24.16", "invalid", ""]) {
      expect(runVersionCheck(version).status, version || "empty version").not.toBe(0);
    }

    expect(script).toContain('OPENCLAW_MIN_NODE_24_VERSION="24.16.0"');
    expect(script).toContain('OPENCLAW_MIN_NODE_26_VERSION="26.1.0"');
    expect(script).toContain("https://deb.nodesource.com/setup_24.x");
    expect(script).toContain("install_openclaw_nodejs");
    expect(script).toContain('hash -r');
    expect(script).toContain('if ! node_meets_openclaw_floor "${installed_node_version}"; then');
  });

  it("upgrades an old Node patch and rejects an insufficient installed result", () => {
    const upgraded = runInstall("v22.22.3", "v24.16.0");
    expect(upgraded.status).toBe(0);
    expect(upgraded.stdout).toContain("installed:v24.16.0");

    const insufficient = runInstall("v22.22.3", "v24.15.9");
    expect(insufficient.status).not.toBe(0);
    expect(insufficient.stderr).toContain(
      "Node.js 24.16.0 to <25 or 26.1.0+ is required; got v24.15.9"
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
