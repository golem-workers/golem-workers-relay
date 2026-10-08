import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveOpenclawConfig } from "./openclawConfig.js";
it.each(["missing", "corrupt", "no-auth"])("allows management startup with %s Gateway config but keeps strict callers strict", kind => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-config-recovery-"));
  const configPath = path.join(dir, "openclaw.json");
  const env = { OPENCLAW_CONFIG_PATH: configPath };
  try {
    if (kind !== "missing") fs.writeFileSync(configPath, kind === "corrupt" ? "{bad" : "{}");
    expect(() => resolveOpenclawConfig(env)).toThrow("gateway auth is not configured");
    expect(resolveOpenclawConfig(env, { allowMissingAuth: true }).gateway.auth.token).toBeUndefined();
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: "repaired" } } }));
    expect(resolveOpenclawConfig(env).gateway.auth.token).toBe("repaired");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
