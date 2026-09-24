import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(resolve("scripts/prepare-agent-server.sh"), "utf8");
const seal = script.split('set_step "openclaw_snapshot_config_seal"')[1]
  .split("<<'NODE'\n")[1].split("\nNODE\n")[0];
type SealedConfig = {
  plugins: { installs?: Record<string, { installPath: string }>; deny: string[] };
  channels?: unknown;
};
const roots: string[] = [];
function fixture(layout: "extensions" | "shared" | "projects" | "record" | "index", whatsappId = "whatsapp") {
  const root = mkdtempSync(join(tmpdir(), "snapshot-seal-"));
  roots.push(root);
  const installs: Record<string, { installPath: string }> = {};
  const packages: Record<string, string> = { codex: "codex", whatsapp: "whatsapp", moonshot: "moonshot-provider", perplexity: "perplexity-plugin" };
  for (const id of ["relay-channel", ...Object.keys(packages)]) {
    const dir = id === "relay-channel" || layout === "extensions"
      ? join(root, "extensions", id)
      : layout === "record" || layout === "index" ? join(root, "custom", id)
      : join(root, "npm", ...(layout === "projects" ? ["projects", `openclaw-${id}-hash`] : []), "node_modules", "@openclaw", packages[id]);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "openclaw.plugin.json"), JSON.stringify({ id: id === "whatsapp" ? whatsappId : id }));
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");
    installs[id] = { installPath: dir };
  }
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({
    plugins: { ...(layout === "record" ? { installs } : {}), entries: { "relay-channel": { enabled: true } } },
    channels: { "relay-channel": { accounts: [{ id: "default" }] } },
  }));
  if (layout === "index") {
    mkdirSync(join(root, "plugins"));
    writeFileSync(join(root, "plugins", "installs.json"), JSON.stringify({ installRecords: installs }));
  }
  return { root, installs };
}
function runSeal(root: string, authored: boolean) {
  return spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: seal.replace('path.join(os.homedir(), ".openclaw")', JSON.stringify(root)),
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_AUTHORED_PLUGIN_INSTALLS: authored ? "1" : "0" },
  });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("snapshot config sealing across OpenClaw install layouts", () => {
  it.each(["extensions", "shared", "projects", "record", "index"] as const)("seals %s installs and keeps legacy install paths", (layout) => {
    const { root, installs } = fixture(layout);
    const result = runSeal(root, true);
    expect(result.status, result.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8")) as SealedConfig;
    expect(config.plugins.installs?.whatsapp.installPath).toBe(installs.whatsapp.installPath);
    expect(config.channels).toBeUndefined();
    expect(config.plugins.deny).toContain("relay-channel");
  });
  it("validates modern npm projects without restoring retired authored installs", () => {
    const { root } = fixture("projects");
    const result = runSeal(root, false);
    expect(result.status, result.stderr).toBe(0);
    expect((JSON.parse(readFileSync(join(root, "openclaw.json"), "utf8")) as SealedConfig).plugins.installs).toBeUndefined();
  });
  it("does not seal a wrong plugin identity", () => {
    const { root } = fixture("projects", "not-whatsapp");
    const before = readFileSync(join(root, "openclaw.json"), "utf8");
    expect(runSeal(root, false).stderr).toContain("Unexpected plugin id");
    expect(readFileSync(join(root, "openclaw.json"), "utf8")).toBe(before);
  });
  it("rejects missing built entrypoints", () => {
    const { root, installs } = fixture("projects");
    rmSync(join(installs.whatsapp.installPath, "dist", "index.js"));
    expect(runSeal(root, false).stderr).toContain("Missing plugin dist/index.js");
  });
  it("ignores incomplete npm staging projects", () => {
    const { root, installs } = fixture("projects");
    rmSync(installs.whatsapp.installPath, { recursive: true });
    const dir = join(root, "npm", "projects", ".openclaw-install-stage-test", "node_modules", "@openclaw", "whatsapp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "openclaw.plugin.json"), JSON.stringify({ id: "whatsapp" }));
    writeFileSync(join(dir, "dist", "index.js"), "");
    expect(runSeal(root, false).stderr).toContain("Unable to resolve installed plugin directory for whatsapp");
  });
});
