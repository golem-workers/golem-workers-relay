import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureRelayChannelPluginUpToDate, comparePluginVersions, type PluginUpdateDeps } from "./ensurePluginUpToDate.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-updater-")); roots.push(root);
  const configPath = path.join(root, "openclaw.json");
  const config = { agents: { defaults: { model: { primary: "codex/test" }, thinkingDefault: "high" } }, auth: { profiles: { keep: {} } }, plugins: { entries: { "relay-channel": { enabled: true, hooks: { allowConversationAccess: false } } } }, channels: { telegram: { enabled: true } } };
  await fs.writeFile(configPath, JSON.stringify(config));
  const state = { current: "1.0.491", latest: "1.0.492", live: "1.0.491", active: true, busy: false, source: "npm", spec: "@golemworkers/relay-channel@1.0.491", enabled: true, hotReload: true, failInstall: false, failPreflight: false, mutateConfig: false, health: true, failRestart: false };
  const exec = vi.fn(async (command: string, args: string[]): Promise<string> => {
    if (command === "npm") return JSON.stringify(state.latest);
    if (args.join(" ") === "plugins list --json") return JSON.stringify({ plugins: [{ id: "relay-channel", enabled: state.enabled, version: state.current, trust: { installSource: state.source, installSpec: state.spec } }] });
    if (args[0] === "plugins" && args[1] === "update") {
      if (state.failPreflight) throw new Error("host incompatible or capability consent required");
      if (args.includes("--dry-run")) return "Would update";
      if (state.failInstall) throw new Error("failure");
      state.current = state.latest;
      if (state.hotReload) state.live = state.latest;
      if (state.mutateConfig) await fs.writeFile(configPath, JSON.stringify({ ...config, auth: {} }));
      return "updated";
    }
    if (args[0] === "gateway" && args[1] === "restart") {
      state.live = state.current;
      if (state.failRestart) throw new Error("lost acknowledgement");
      return JSON.stringify({ ok: true });
    }
    switch (args[2]) {
      case "gateway.restart.preflight": return JSON.stringify({ safe: !state.busy, counts: { totalActive: state.busy ? 1 : 0 } });
      case "plugins.list": return JSON.stringify({ plugins: [{ id: "relay-channel", version: state.live, runtime: { state: state.active ? "active" : "unloaded" } }] });
      case "health": return JSON.stringify({ ok: state.health });
    }
    throw new Error("unexpected command");
  });
  const deps: PluginUpdateDeps = { exec, sleep: vi.fn(() => Promise.resolve()) };
  return { root, configPath, config, state, exec, deps, run: () => ensureRelayChannelPluginUpToDate({ openclawConfigPath: configPath }, deps) };
}

describe("periodic relay-channel update transaction", () => {
  it("updates the exact stable npm release, verifies hot activation, and preserves config/consent", async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({ status: "updated", version: "1.0.492" });
    expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toEqual(f.config);
    const args = f.exec.mock.calls.flatMap(call => call[1]);
    expect(args).not.toContain("--accept-capabilities"); expect(args).not.toContain("--force"); expect(args).not.toContain("uninstall"); expect(args).not.toContain("restart");
    expect(f.exec).toHaveBeenCalledWith("openclaw", ["plugins", "update", "@golemworkers/relay-channel@1.0.492"], 600_000);
    expect(f.exec).toHaveBeenCalledWith("npm", ["view", "@golemworkers/relay-channel@latest", "version", "--json", "--registry=https://registry.npmjs.org"], 30_000);
  });
  it.each(["1.0.492", "1.1.0"])("does not reinstall/downgrade %s", async current => {
    const f = await fixture(); f.state.current = current;
    expect((await f.run()).status).toBe("unchanged"); expect(f.exec.mock.calls.some(c => c[1].includes("update"))).toBe(false);
  });
  it.each(["1.0.493-beta.1", "latest;bad"])("rejects nonstable/malformed published version %s", async latest => {
    const f = await fixture(); f.state.latest = latest;
    await expect(f.run()).rejects.toThrow("PLUGIN_RELEASE_INVALID"); expect(f.exec.mock.calls.some(c => c[1].includes("update"))).toBe(false);
  });
  it.each(["disabled", "custom", "source", "prerelease"])("preserves %s installations", async kind => {
    const f = await fixture();
    if (kind === "disabled") f.state.enabled = false;
    if (kind === "custom") f.state.spec = "file:/srv/development";
    if (kind === "source") f.state.source = "path";
    if (kind === "prerelease") f.state.current = "1.0.493-beta.1";
    expect((await f.run()).status).toBe("deferred"); expect(f.exec.mock.calls.some(c => c[0] === "npm")).toBe(false);
  });
  it("defers busy Gateways without changing packages or restarting", async () => {
    const f = await fixture(); f.state.busy = true;
    expect(await f.run()).toEqual({ status: "deferred", reason: "gateway-busy" });
    expect(f.exec.mock.calls.some(c => c[1].includes("update"))).toBe(false);
  });
  it("keeps compatibility/capability failure read-only", async () => {
    const f = await fixture(); f.state.failPreflight = true;
    await expect(f.run()).rejects.toThrow(); expect(f.state.current).toBe("1.0.491");
    await expect(fs.stat(f.configPath + ".relay-channel-update.json")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not blindly retry an ambiguous installer result", async () => {
    const f = await fixture(); f.state.failInstall = true;
    await expect(f.run()).rejects.toThrow(); f.exec.mockClear();
    await expect(f.run()).rejects.toThrow("PLUGIN_UPDATE_OUTCOME_UNRESOLVED");
    expect(f.exec.mock.calls.some(c => c[1].includes("update"))).toBe(false);
  });
  it("requests safe restart only if hot activation is absent, then verifies runtime", async () => {
    const f = await fixture(); f.state.hotReload = false;
    expect((await f.run()).status).toBe("updated");
    expect(f.exec).toHaveBeenCalledWith("openclaw", ["gateway", "restart", "--safe", "--json"], 30_000);
  });
  it("recovers lost restart acknowledgement without reinstall/restart storm", async () => {
    const f = await fixture(); f.state.hotReload = false; f.state.failRestart = true;
    await expect(f.run()).rejects.toThrow("lost acknowledgement"); f.exec.mockClear();
    expect((await f.run()).status).toBe("updated");
    expect(f.exec.mock.calls.some(c => c[1].includes("update") || c[1].includes("restart"))).toBe(false);
  });
  it("does not report success on unhealthy runtime", async () => {
    const f = await fixture(); f.state.health = false;
    await expect(f.run()).rejects.toThrow("PLUGIN_RUNTIME_ACTIVATION_UNVERIFIED");
    f.exec.mockClear(); await expect(f.run()).rejects.toThrow("PLUGIN_RUNTIME_ACTIVATION_UNVERIFIED");
    expect(f.exec.mock.calls.some(c => c[1].includes("restart"))).toBe(false);
  });
  it("detects config mutation and never overwrites it with a stale backup", async () => {
    const f = await fixture(); f.state.mutateConfig = true;
    await expect(f.run()).rejects.toThrow("PLUGIN_CONFIG_PRESERVATION_FAILED");
    expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({ auth: {} });
  });
  it("retains the pre-update config hash across lost acknowledgements", async () => {
    const f = await fixture(); f.state.hotReload = false; f.state.failRestart = true;
    await expect(f.run()).rejects.toThrow();
    await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, auth: {} })); f.exec.mockClear();
    await expect(f.run()).rejects.toThrow("PLUGIN_CONFIG_PRESERVATION_FAILED");
    expect(f.exec.mock.calls.some(c => c[1].includes("update") || c[1].includes("restart"))).toBe(false);
  });
  it("compares numeric versions without lexicographic ordering", () => {
    expect(comparePluginVersions("1.0.99", "1.0.100")).toBe(-1);
  });
});
