import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(
  process.cwd(),
  "scripts/patch-openclaw-ai-attachment-replay.mjs",
);

function createPackage(version: string, hostSource: string): {
  packageDir: string;
  hostPath: string;
} {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ai-patch-"));
  const distDir = path.join(packageDir, "dist");
  fs.mkdirSync(distDir);
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version }));
  const hostPath = path.join(distDir, "host-test.mjs");
  fs.writeFileSync(hostPath, hostSource);
  return { packageDir, hostPath };
}

describe("patch-openclaw-ai-attachment-replay", () => {
  it("guards OpenClaw 2026.8.1 replay from non-tool assistant blocks", () => {
    const fixture = createPackage(
      "2026.8.1",
      [
        "function transform(block) {",
        "  if (block.type === \"text\") return block;",
        "  const trimmedId = block.id.trim();",
        "  return trimmedId;",
        "}",
      ].join("\n"),
    );

    const firstRun = execFileSync(process.execPath, [scriptPath, fixture.packageDir], {
      encoding: "utf8",
    });
    const patched = fs.readFileSync(fixture.hostPath, "utf8");
    expect(firstRun).toContain("Patched OpenClaw AI 2026.8.1 attachment replay");
    expect(patched).toContain('if (block.type !== "toolCall") return [];');
    expect(patched.indexOf('if (block.type !== "toolCall")')).toBeLessThan(
      patched.indexOf("block.id.trim()"),
    );

    const secondRun = execFileSync(process.execPath, [scriptPath, fixture.packageDir], {
      encoding: "utf8",
    });
    expect(secondRun).toContain("already patched");
  });

  it("leaves other OpenClaw AI releases untouched", () => {
    const source = "const trimmedId = block.id.trim();\n";
    const fixture = createPackage("2026.8.2", source);

    const output = execFileSync(process.execPath, [scriptPath, fixture.packageDir], {
      encoding: "utf8",
    });
    expect(output).toContain("does not require attachment replay patch");
    expect(fs.readFileSync(fixture.hostPath, "utf8")).toBe(source);
  });

  it("fails closed when the affected package layout drifts", () => {
    const fixture = createPackage("2026.8.1", "export const unchanged = true;\n");

    const result = spawnSync(process.execPath, [scriptPath, fixture.packageDir], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected exactly one OpenClaw AI 2026.8.1 attachment replay target");
  });
});
