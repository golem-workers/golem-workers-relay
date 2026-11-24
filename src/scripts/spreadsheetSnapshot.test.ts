import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("both snapshot paths can use the shared Ubuntu dependency installer before runtime checks", () => {
  const script = readFileSync(resolve("scripts/prepare-spreadsheet-runtime.sh"), "utf8");
  const dir = mkdtempSync(resolve(tmpdir(), "spreadsheet-apt-"));
  try {
    writeFileSync(resolve(dir, "prepare-spreadsheet-runtime.sh"), script);
    writeFileSync(resolve(dir, "apt-get"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\n', {mode: 0o755});
    writeFileSync(resolve(dir, "install-spreadsheet-tools.sh"), '#!/bin/sh\nprintf "runtime-install\\n" >> "$TRACE"\n');
    const result = spawnSync("bash", [resolve(dir, "prepare-spreadsheet-runtime.sh")], {
      encoding: "utf8", env: {...process.env, PATH: `${dir}:${process.env.PATH}`, TRACE: resolve(dir, "trace")},
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(resolve(dir, "trace"), "utf8").trim().split("\n");
    expect(calls[0]).toBe("update");
    expect(calls[1]).toContain("install -y --no-install-recommends");
    for (const pkg of ["libreoffice-calc", "python3-uno", "python3-openpyxl", "python3-pil", "python3-xlrd", "fonts-dejavu-core", "poppler-utils"]) {
      expect(calls[1].split(" ")).toContain(pkg);
    }
    expect(calls[2]).toBe("runtime-install");
    const prepare = readFileSync(resolve("scripts/prepare-agent-server.sh"), "utf8");
    expect(prepare).toContain('bash "${RELAY_REPO_DIR}/scripts/prepare-spreadsheet-runtime.sh"');
    expect(prepare).toContain('${RELAY_REPO_DIR}/tools/golem-spreadsheets/manifest.sha256');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
