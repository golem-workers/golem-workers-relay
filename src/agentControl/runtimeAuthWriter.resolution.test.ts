import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("prefers the active executable SDK over an obsolete NODE_PATH install (#656)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-sdk-resolution-"));
  try {
    for (const install of ["active", "stale"]) {
      const pkg = path.join(root, install, "node_modules/openclaw");
      await fs.mkdir(pkg, { recursive: true });
      await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: { "./plugin-sdk/provider-auth": "./auth.js" } }));
      await fs.writeFile(path.join(pkg, "openclaw.mjs"), "");
      await fs.writeFile(path.join(pkg, "auth.js"), "export const marker = '" + install + "';");
    }
    await fs.mkdir(path.join(root, "bin"));
    await fs.symlink(path.join(root, "active/node_modules/openclaw/openclaw.mjs"), path.join(root, "bin/openclaw"));
    // Fresh process is essential: Node snapshots NODE_PATH during startup.
    const source = pathToFileURL(path.resolve("src/agentControl/runtimeAuthWriter.ts")).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const { resolveRuntimeAuthSdk } = await import(" + JSON.stringify(source) + "); console.log(await resolveRuntimeAuthSdk());"], {
      env: { ...process.env, PATH: path.join(root, "bin"), NODE_PATH: path.join(root, "stale/node_modules") },
    });
    expect(stdout.trim()).toBe(path.join(root, "active/node_modules/openclaw/auth.js"));
    const run = (searchPath: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const { resolveRuntimeAuthSdk } = await import(" + JSON.stringify(source) + "); console.log(await resolveRuntimeAuthSdk());"], {
      env: { ...process.env, PATH: searchPath, NODE_PATH: path.join(root, "stale/node_modules") },
    });
    // Ordinary module-only installations remain supported.
    expect((await run(root)).stdout.trim()).toBe(path.join(root, "stale/node_modules/openclaw/auth.js"));
    // A known active package with no SDK must not silently use an obsolete SDK.
    await fs.writeFile(path.join(root, "active/node_modules/openclaw/package.json"), JSON.stringify({ name: "openclaw", type: "module", exports: {} }));
    await expect(run(path.join(root, "bin"))).rejects.toThrow("refusing stale SDK fallback");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
