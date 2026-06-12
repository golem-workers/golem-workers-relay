import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("prepare-agent-server.sh", () => {
  it("links stable OpenClaw and Codex commands to package bin entries instead of pnpm shims", () => {
    const script = readFileSync(resolve(process.cwd(), "scripts/prepare-agent-server.sh"), "utf8");

    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/codex" /usr/local/bin/codex');
    expect(script).toContain('ln -sfn "${GLOBAL_PNPM_ROOT}/.bin/openclaw" /usr/local/bin/openclaw');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/codex" /usr/local/bin/codex');
    expect(script).not.toContain('ln -sfn "${PNPM_HOME_DIR}/openclaw" /usr/local/bin/openclaw');
  });
});
