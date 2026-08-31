#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const AFFECTED_VERSIONS = new Set(["2026.8.1"]);
const VULNERABLE_SOURCE = "const trimmedId = block.id.trim();";
const PATCHED_SOURCE = [
  'if (block.type !== "toolCall") return [];',
  VULNERABLE_SOURCE,
].join("\n\t\t");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const packageDir = process.argv[2];
if (!packageDir) {
  fail("Usage: patch-openclaw-ai-attachment-replay.mjs <@openclaw/ai-package-dir>");
}

const packageJsonPath = path.join(packageDir, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  fail(`Missing @openclaw/ai package.json: ${packageJsonPath}`);
}
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = typeof packageJson.version === "string" ? packageJson.version : "";
if (!AFFECTED_VERSIONS.has(version)) {
  process.stdout.write(`OpenClaw AI ${version || "unknown"} does not require attachment replay patch\n`);
  process.exit(0);
}

const distDir = path.join(packageDir, "dist");
const hostFiles = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /^host-.*\.mjs$/.test(entry.name))
  .map((entry) => path.join(distDir, entry.name));
let patchedCount = 0;
let alreadyPatchedCount = 0;
for (const filePath of hostFiles) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(PATCHED_SOURCE)) {
    alreadyPatchedCount += 1;
    continue;
  }
  const occurrences = source.split(VULNERABLE_SOURCE).length - 1;
  if (occurrences === 0) continue;
  if (occurrences !== 1) {
    fail(`Unexpected attachment replay patch target count ${occurrences} in ${filePath}`);
  }
  fs.writeFileSync(filePath, source.replace(VULNERABLE_SOURCE, PATCHED_SOURCE));
  patchedCount += 1;
}

if (patchedCount + alreadyPatchedCount !== 1) {
  fail(
    `Expected exactly one OpenClaw AI ${version} attachment replay target, found ${patchedCount + alreadyPatchedCount}`,
  );
}
process.stdout.write(
  patchedCount === 1
    ? `Patched OpenClaw AI ${version} attachment replay\n`
    : `OpenClaw AI ${version} attachment replay already patched\n`,
);
