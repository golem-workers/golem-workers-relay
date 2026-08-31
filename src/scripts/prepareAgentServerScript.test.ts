import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const prepareAgentServerScriptPath = resolve(process.cwd(), "scripts/prepare-agent-server.sh");

describe("prepare-agent-server snapshot preparation", () => {
  it("accepts plugin capabilities only when the installed OpenClaw CLI supports it", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain("configure_openclaw_plugin_cli_args() {");
    expect(script).toContain('if [[ "${install_help}" == *"--accept-capabilities"* ]]');
    expect(script).toContain("OPENCLAW_PLUGIN_CAPABILITY_ARGS=(--accept-capabilities)");
    expect(script).toContain("OPENCLAW_AUTHORED_PLUGIN_INSTALLS=0");
    expect(script).toContain(
      'const authoredPluginInstalls = process.env.OPENCLAW_AUTHORED_PLUGIN_INSTALLS !== "0"'
    );
    expect(script).toContain("delete pluginsCfg.installs");
    expect(script).toContain("configure_openclaw_plugin_cli_args");
    expect(script).toContain(
      'openclaw plugins install --force "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" "${RELAY_CHANNEL_BUNDLE_TGZ}"'
    );
    expect(script).toContain(
      'openclaw plugins install "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" "${CODEX_PLUGIN_NPM_SPEC}"'
    );
    expect(script).toContain(
      'openclaw plugins install "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" "${WHATSAPP_PLUGIN_INSTALL_SPEC}"'
    );
    expect(script).toContain(
      'openclaw plugins enable "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" whatsapp'
    );
  });

  it("resolves the Codex plugin from its own compatible npm revision stream", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain('if [[ -n "${OPENCLAW_CODEX_PLUGIN_SPEC:-}" ]]');
    expect(script).toContain("resolve-openclaw-codex-plugin-version.mjs");
    expect(script).toContain('CODEX_PLUGIN_NPM_SPEC="@openclaw/codex@${CODEX_PLUGIN_VERSION}"');
    expect(script).not.toContain('CODEX_PLUGIN_NPM_SPEC="@openclaw/codex@${OPENCLAW_INSTALLED_VERSION}"');
  });

  it("bakes Google Meet browser and PulseAudio dependencies into provider snapshots", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain("xvfb \\");
    expect(script).toContain("pulseaudio \\");
    expect(script).toContain("pulseaudio-utils \\");
    expect(script).toContain("google-chrome-stable_current_amd64.deb");
    expect(script).toContain("https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb");
    expect(script).toContain("google-chrome-stable --version");
    expect(script).toContain("command -v Xvfb");
    expect(script).toContain("command -v pulseaudio");
    expect(script).toContain("command -v pactl");
    expect(script).toContain("command -v parec");
    expect(script).toContain("command -v pacat");
  });

  it("raises the generated gateway unit heap floor before readiness recovery", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain('OPENCLAW_GATEWAY_SNAPSHOT_HEAP_MIB="768"');
    expect(script).toContain(
      'OPENCLAW_GATEWAY_SNAPSHOT_NODE_OPTIONS="--max-old-space-size=${OPENCLAW_GATEWAY_SNAPSHOT_HEAP_MIB} --enable-source-maps"'
    );
    expect(script).toContain(
      'Environment=\\"NODE_OPTIONS=${OPENCLAW_GATEWAY_SNAPSHOT_NODE_OPTIONS}\\"'
    );
    expect(script).toContain(
      's|--max-old-space-size=[0-9]+|--max-old-space-size=${OPENCLAW_GATEWAY_SNAPSHOT_HEAP_MIB}|g'
    );
    expect(script).toContain("configure_openclaw_gateway_snapshot_heap");
    expect(script.indexOf("OPENCLAW_GATEWAY_SNAPSHOT_NODE_OPTIONS")).toBeLessThan(
      script.indexOf("systemctl --user restart openclaw-gateway.service")
    );
  });

  it("allows slow first database bootstrap before failing gateway readiness", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain(
      'OPENCLAW_GATEWAY_READINESS_ATTEMPTS="${OPENCLAW_GATEWAY_READINESS_ATTEMPTS:-360}"'
    );
    expect(script).toContain(
      'OPENCLAW_GATEWAY_READINESS_SLEEP_SECONDS="${OPENCLAW_GATEWAY_READINESS_SLEEP_SECONDS:-2}"'
    );
    expect(script).toContain(
      'local attempts="${1:-${OPENCLAW_GATEWAY_READINESS_ATTEMPTS}}"'
    );
    expect(script).toContain(
      'local sleep_seconds="${2:-${OPENCLAW_GATEWAY_READINESS_SLEEP_SECONDS}}"'
    );
  });

  it("bakes sqlite3 into provider snapshots", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain("sqlite3 \\");
  });

  it("bakes the WhatsApp plugin into provider snapshots before channel warmup", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain(
      'OPENCLAW_WHATSAPP_PLUGIN_SPEC="${OPENCLAW_WHATSAPP_PLUGIN_SPEC:-}"'
    );
    expect(script).toContain('if [[ -n "${OPENCLAW_WHATSAPP_PLUGIN_SPEC}" ]]');
    expect(script).toContain("resolve-openclaw-whatsapp-plugin-version.mjs");
    expect(script).toContain(
      'WHATSAPP_PLUGIN_INSTALL_SPEC="clawhub:@openclaw/whatsapp@${WHATSAPP_PLUGIN_VERSION}"'
    );
    expect(script).toContain("install_openclaw_whatsapp_plugin() {");
    expect(script).toContain(
      'openclaw plugins install "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" "${WHATSAPP_PLUGIN_INSTALL_SPEC}"'
    );
    expect(script).toContain(
      'openclaw plugins enable "${OPENCLAW_PLUGIN_CAPABILITY_ARGS[@]}" whatsapp'
    );
    expect(script).toContain('dmPolicy: "allowlist"');
    expect(script).toContain('groupPolicy: "disabled"');
    expect(script).toContain("sendReadReceipts: true");
    expect(script).not.toContain("allowFrom: [],");
    expect(script).not.toContain("groupAllowFrom: [],");
    expect(script).toContain('const requiredPluginIds = ["relay-channel", "codex", "whatsapp"]');
    expect(script).toContain(
      'const installedButDisabledPluginIds = ["relay-channel", "codex", "telegram"]'
    );
    expect(script.indexOf('set_step "openclaw_whatsapp_plugin_install"')).toBeGreaterThan(
      script.indexOf('set_step "openclaw_snapshot_channels_warmup_config"')
    );
    expect(script.indexOf('set_step "openclaw_whatsapp_plugin_install"')).toBeLessThan(
      script.indexOf('set_step "openclaw_snapshot_channels_warmup_start"')
    );
  });

  it("bakes curated OpenClaw skills into provider snapshots before onboarding", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain("OPENCLAW_SAFE_SKILL_SPECS=(");
    expect(script).toContain('"@steipete/github"');
    expect(script).not.toContain('"@gpyangyoujun/multi-search-engine"');
    expect(script).toContain('"@matrixy/agent-browser-clawdbot"');
    expect(script).not.toContain('"@peytoncasper/browser-automation"');
    expect(script).toContain('"@ivangdavila/data-analysis"');
    expect(script).toContain('"@michaelgathara/youtube-watcher"');
    expect(script).toContain('"@lamelas/himalaya"');
    expect(script).toContain("preinstall_openclaw_safe_skills() {");
    expect(script).toContain('openclaw skills install "${skill_spec}"');
    expect(script).toContain('test -s "${skill_dir}/SKILL.md"');
    expect(script.indexOf('set_step "openclaw_safe_skills_preinstall"')).toBeGreaterThan(
      script.indexOf('set_step "openclaw_codex_plugin_install"')
    );
    expect(script.indexOf('set_step "openclaw_safe_skills_preinstall"')).toBeLessThan(
      script.indexOf('set_step "openclaw_onboard"')
    );
  });
});
