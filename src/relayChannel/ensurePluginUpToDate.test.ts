import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { comparePluginVersions, ensureRelayChannelPluginUpToDate } from "./ensurePluginUpToDate.js";

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe("comparePluginVersions", () => {
  it("compares numeric dotted versions", () => {
    expect(comparePluginVersions("1.0.13", "1.0.13")).toBe(0);
    expect(comparePluginVersions("1.0.12", "1.0.13")).toBeLessThan(0);
    expect(comparePluginVersions("1.0.14", "1.0.13")).toBeGreaterThan(0);
    expect(comparePluginVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("ensureRelayChannelPluginUpToDate", () => {
  it("skips reinstall when install record is missing but the default extension dir is current", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-default-dir-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const installDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.writeFile(
      path.join(installDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "relay-channel" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            entries: {
              "relay-channel": {
                enabled: false,
                config: { accounts: [{ id: "default", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "default", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );

    const commands: string[] = [];
    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: (command, args) => {
          commands.push([command, ...args].join(" "));
          return Promise.resolve({ stdout: "", stderr: "" });
        },
        sleep: () => Promise.resolve(),
      }
    );

    expect(commands).toEqual([
      "git fetch --prune origin release",
      "git checkout release",
      "git reset --hard origin/release",
    ]);
  });

  it("skips reinstall when installed plugin already matches the desired version", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-sync-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const installDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            installs: {
              "relay-channel": {
                installPath: installDir,
              },
            },
            entries: {
              "relay-channel": {
                enabled: true,
                config: { accounts: [{ id: "default", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "default", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );

    const commands: string[] = [];
    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: (command, args) => {
          commands.push([command, ...args].join(" "));
          return Promise.resolve({ stdout: "", stderr: "" });
        },
        sleep: () => Promise.resolve(),
      }
    );

    expect(commands).toEqual([
      "git fetch --prune origin release",
      "git checkout release",
      "git reset --hard origin/release",
    ]);
  });

  it("reinstalls on disk without restarting the gateway when the installed plugin version is outdated", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-update-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const installDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel-old");
    const gatewayUnitPath = path.join(tempRoot, ".config", "systemd", "user", "openclaw-gateway.service");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.12" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            installs: {
              "relay-channel": {
                installPath: installDir,
              },
            },
            entries: {
              "relay-channel": {
                enabled: true,
                config: { accounts: [{ id: "srv_1", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "srv_1", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );
    await fs.mkdir(path.dirname(gatewayUnitPath), { recursive: true });
    await fs.writeFile(gatewayUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n");

    let gatewayActiveState = "active";
    let gatewaySubState = "running";
    let gatewayResult = "success";
    const commands: string[] = [];
    const finalInstallDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");

    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: async (command, args, options) => {
          commands.push([command, ...args].join(" "));

          if (command === "git") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "ci --include=dev") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "run bundle:agent") {
            const bundlePath = path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz");
            await fs.mkdir(path.dirname(bundlePath), { recursive: true });
            await fs.writeFile(bundlePath, "bundle");
            return { stdout: "", stderr: "" };
          }

          if (command === "systemctl" && args.includes("show")) {
            const property = args[4];
            if (property === "ActiveState") {
              return { stdout: `${gatewayActiveState}\n`, stderr: "" };
            }
            if (property === "SubState") {
              return { stdout: `${gatewaySubState}\n`, stderr: "" };
            }
            if (property === "Result") {
              return { stdout: `${gatewayResult}\n`, stderr: "" };
            }
          }

          if (command === "systemctl" && args.join(" ") === "--user stop openclaw-gateway.service") {
            gatewayActiveState = "inactive";
            gatewaySubState = "dead";
            return { stdout: "", stderr: "" };
          }

          if (command === "systemctl" && args.join(" ") === "--user reset-failed openclaw-gateway.service") {
            gatewayResult = "success";
            return { stdout: "", stderr: "" };
          }

          if (command === "systemctl" && args.join(" ") === "--user restart openclaw-gateway.service") {
            gatewayActiveState = "active";
            gatewaySubState = "running";
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins uninstall relay-channel --force") {
            await fs.rm(installDir, { recursive: true, force: true });
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args[0] === "plugins" && args[1] === "install") {
            await fs.mkdir(path.join(finalInstallDir, "dist"), { recursive: true });
            await fs.writeFile(
              path.join(finalInstallDir, "package.json"),
              `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
            );
            await fs.writeFile(
              path.join(finalInstallDir, "openclaw.plugin.json"),
              `${JSON.stringify({ id: "relay-channel" }, null, 2)}\n`
            );
            await fs.writeFile(path.join(finalInstallDir, "dist", "index.js"), "export {};\n");
            const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
            const plugins = rawConfig.plugins as {
              installs?: Record<string, unknown>;
            };
            plugins.installs = plugins.installs ?? {};
            plugins.installs["relay-channel"] = { installPath: finalInstallDir };
            await fs.writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins enable relay-channel") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")} (cwd=${options?.cwd ?? ""})`);
        },
        sleep: () => Promise.resolve(),
      }
    );

    const updatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      plugins: {
        installs: Record<string, { installPath: string }>;
        entries: Record<string, { enabled: boolean; config: { accounts: Array<{ id: string; port: number }> } }>;
      };
      channels: Record<string, { accounts: Array<{ id: string; port: number }> }>;
    };
    const updatedPkg = JSON.parse(await fs.readFile(path.join(finalInstallDir, "package.json"), "utf8")) as {
      version: string;
    };

    expect(updatedPkg.version).toBe("1.0.13");
    expect(updatedConfig.plugins.installs["relay-channel"]?.installPath).toBe(finalInstallDir);
    expect(updatedConfig.plugins.entries["relay-channel"]).toEqual({
      enabled: true,
      config: { accounts: [{ id: "srv_1", port: 43129 }] },
    });
    expect(updatedConfig.channels["relay-channel"]).toEqual({
      accounts: [{ id: "srv_1", port: 43129 }],
    });
    expect(commands).toContain("npm ci --include=dev");
    expect(commands).toContain("openclaw plugins uninstall relay-channel --force");
    expect(commands).toContain("openclaw plugins install " + path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz"));
    expect(commands).not.toContain("systemctl --user stop openclaw-gateway.service");
    expect(commands).not.toContain("systemctl --user restart openclaw-gateway.service");
  });

  it("does not restart an inactive gateway service after updating the plugin", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-update-inactive-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const installDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel-old");
    const finalInstallDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");
    const gatewayUnitPath = path.join(tempRoot, ".config", "systemd", "user", "openclaw-gateway.service");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.12" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            installs: {
              "relay-channel": {
                installPath: installDir,
              },
            },
            entries: {
              "relay-channel": {
                enabled: true,
                config: { accounts: [{ id: "srv_1", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "srv_1", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );
    await fs.mkdir(path.dirname(gatewayUnitPath), { recursive: true });
    await fs.writeFile(gatewayUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n");

    const commands: string[] = [];
    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: async (command, args, options) => {
          commands.push([command, ...args].join(" "));

          if (command === "git") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "ci --include=dev") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "run bundle:agent") {
            const bundlePath = path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz");
            await fs.mkdir(path.dirname(bundlePath), { recursive: true });
            await fs.writeFile(bundlePath, "bundle");
            return { stdout: "", stderr: "" };
          }

          if (command === "systemctl" && args.includes("show")) {
            const property = args[4];
            if (property === "ActiveState") {
              return { stdout: "inactive\n", stderr: "" };
            }
            if (property === "SubState") {
              return { stdout: "dead\n", stderr: "" };
            }
            if (property === "Result") {
              return { stdout: "success\n", stderr: "" };
            }
          }

          if (command === "openclaw" && args.join(" ") === "plugins uninstall relay-channel --force") {
            await fs.rm(installDir, { recursive: true, force: true });
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args[0] === "plugins" && args[1] === "install") {
            await fs.mkdir(finalInstallDir, { recursive: true });
            await fs.writeFile(
              path.join(finalInstallDir, "package.json"),
              `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
            );
            await fs.writeFile(
              path.join(finalInstallDir, "openclaw.plugin.json"),
              `${JSON.stringify({ id: "relay-channel" }, null, 2)}\n`
            );
            const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
            const plugins = rawConfig.plugins as {
              installs?: Record<string, unknown>;
            };
            plugins.installs = plugins.installs ?? {};
            plugins.installs["relay-channel"] = { installPath: finalInstallDir };
            await fs.writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins enable relay-channel") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")} (cwd=${options?.cwd ?? ""})`);
        },
        sleep: () => Promise.resolve(),
      }
    );

    expect(commands).toContain("openclaw plugins install " + path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz"));
    expect(commands).not.toContain("systemctl --user stop openclaw-gateway.service");
    expect(commands).not.toContain("systemctl --user restart openclaw-gateway.service");
  });

  it("does not stop a gateway that becomes active after plugin update starts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-update-race-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const installDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel-old");
    const finalInstallDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");
    const gatewayUnitPath = path.join(tempRoot, ".config", "systemd", "user", "openclaw-gateway.service");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(installDir, { recursive: true });
    await fs.writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.12" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            installs: {
              "relay-channel": {
                installPath: installDir,
              },
            },
            entries: {
              "relay-channel": {
                enabled: true,
                config: { accounts: [{ id: "srv_1", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "srv_1", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );
    await fs.mkdir(path.dirname(gatewayUnitPath), { recursive: true });
    await fs.writeFile(gatewayUnitPath, "[Unit]\nDescription=OpenClaw Gateway\n");

    let gatewayActiveState = "inactive";
    const commands: string[] = [];
    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: async (command, args, options) => {
          commands.push([command, ...args].join(" "));

          if (command === "git") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "ci --include=dev") {
            gatewayActiveState = "active";
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "run bundle:agent") {
            const bundlePath = path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz");
            await fs.mkdir(path.dirname(bundlePath), { recursive: true });
            await fs.writeFile(bundlePath, "bundle");
            return { stdout: "", stderr: "" };
          }

          if (command === "systemctl" && args.includes("show")) {
            const property = args[4];
            if (property === "ActiveState") {
              return { stdout: `${gatewayActiveState}\n`, stderr: "" };
            }
            if (property === "SubState") {
              return { stdout: `${gatewayActiveState === "active" ? "running" : "dead"}\n`, stderr: "" };
            }
            if (property === "Result") {
              return { stdout: "success\n", stderr: "" };
            }
          }

          if (command === "openclaw" && args.join(" ") === "plugins uninstall relay-channel --force") {
            await fs.rm(installDir, { recursive: true, force: true });
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args[0] === "plugins" && args[1] === "install") {
            await fs.mkdir(finalInstallDir, { recursive: true });
            await fs.writeFile(
              path.join(finalInstallDir, "package.json"),
              `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
            );
            await fs.writeFile(
              path.join(finalInstallDir, "openclaw.plugin.json"),
              `${JSON.stringify({ id: "relay-channel" }, null, 2)}\n`
            );
            const rawConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
            const plugins = rawConfig.plugins as {
              installs?: Record<string, unknown>;
            };
            plugins.installs = plugins.installs ?? {};
            plugins.installs["relay-channel"] = { installPath: finalInstallDir };
            await fs.writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins enable relay-channel") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")} (cwd=${options?.cwd ?? ""})`);
        },
        sleep: () => Promise.resolve(),
      }
    );

    expect(commands).toContain("openclaw plugins install " + path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz"));
    expect(commands).not.toContain("systemctl --user stop openclaw-gateway.service");
    expect(commands).not.toContain("systemctl --user restart openclaw-gateway.service");
  });

  it("accepts a successful install even when OpenClaw omits plugins.installs", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "relay-plugin-install-no-record-"));
    process.env.HOME = tempRoot;
    const repoDir = path.join(tempRoot, "plugin-repo");
    const configPath = path.join(tempRoot, ".openclaw", "openclaw.json");
    const finalInstallDir = path.join(tempRoot, ".openclaw", "extensions", "relay-channel");

    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
    );
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            entries: {
              "relay-channel": {
                enabled: false,
                config: { accounts: [{ id: "srv_1", port: 43129 }] },
              },
            },
          },
          channels: {
            "relay-channel": {
              accounts: [{ id: "srv_1", port: 43129 }],
            },
          },
        },
        null,
        2
      )}\n`
    );

    const commands: string[] = [];
    await ensureRelayChannelPluginUpToDate(
      {
        openclawConfigPath: configPath,
        plugin: {
          autoUpdateEnabled: true,
          repoDir,
          repoUrl: "https://example.com/plugin.git",
          gitRef: "release",
        },
      },
      {
        exec: async (command, args, options) => {
          commands.push([command, ...args].join(" "));

          if (command === "git") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "ci --include=dev") {
            return { stdout: "", stderr: "" };
          }

          if (command === "npm" && args.join(" ") === "run bundle:agent") {
            const bundlePath = path.join(repoDir, ".artifacts", "relay-channel", "relay-channel-bundle.tgz");
            await fs.mkdir(path.dirname(bundlePath), { recursive: true });
            await fs.writeFile(bundlePath, "bundle");
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins uninstall relay-channel --force") {
            await fs.rm(finalInstallDir, { recursive: true, force: true });
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args[0] === "plugins" && args[1] === "install") {
            await fs.mkdir(finalInstallDir, { recursive: true });
            await fs.writeFile(
              path.join(finalInstallDir, "package.json"),
              `${JSON.stringify({ name: "golem-workers-openclaw-channel-plugin", version: "1.0.13" }, null, 2)}\n`
            );
            await fs.writeFile(
              path.join(finalInstallDir, "openclaw.plugin.json"),
              `${JSON.stringify({ id: "relay-channel" }, null, 2)}\n`
            );
            return { stdout: "", stderr: "" };
          }

          if (command === "openclaw" && args.join(" ") === "plugins disable relay-channel") {
            return { stdout: "", stderr: "" };
          }

          throw new Error(`Unexpected command: ${command} ${args.join(" ")} (cwd=${options?.cwd ?? ""})`);
        },
        sleep: () => Promise.resolve(),
      }
    );

    const installedPkg = JSON.parse(await fs.readFile(path.join(finalInstallDir, "package.json"), "utf8")) as {
      version: string;
    };
    expect(installedPkg.version).toBe("1.0.13");
    expect(commands).toContain("openclaw plugins uninstall relay-channel --force");
    expect(commands).toContain("openclaw plugins disable relay-channel");
  });
});
