import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const prepareAgentServerScriptPath = resolve(process.cwd(), "scripts/prepare-agent-server.sh");

describe("prepare-agent-server snapshot preparation", () => {
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

  it("bakes the WhatsApp plugin into provider snapshots before channel warmup", () => {
    const script = readFileSync(prepareAgentServerScriptPath, "utf8");

    expect(script).toContain(
      'OPENCLAW_WHATSAPP_PLUGIN_SPEC="${OPENCLAW_WHATSAPP_PLUGIN_SPEC:-clawhub:@openclaw/whatsapp}"'
    );
    expect(script).toContain("install_openclaw_whatsapp_plugin() {");
    expect(script).toContain('openclaw plugins install "${OPENCLAW_WHATSAPP_PLUGIN_SPEC}"');
    expect(script).toContain("openclaw plugins enable whatsapp");
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
    expect(script).toContain('"@peytoncasper/browser-automation"');
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
