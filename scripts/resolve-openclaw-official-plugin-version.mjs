#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveCompatibleOfficialPluginVersion(
  packageName,
  openclawVersion,
  availableVersions,
) {
  const normalizedPackageName = String(packageName ?? "").trim();
  if (!normalizedPackageName.startsWith("@openclaw/")) {
    throw new Error(
      `Unsupported official OpenClaw plugin package: ${normalizedPackageName || "missing"}`,
    );
  }

  const normalizedOpenclawVersion = String(openclawVersion ?? "").trim();
  const coreMatch = /^(\d+\.\d+\.\d+)(?:-\d+)?$/.exec(
    normalizedOpenclawVersion,
  );
  if (!coreMatch) {
    throw new Error(
      `Unsupported stable OpenClaw version: ${normalizedOpenclawVersion || "missing"}`,
    );
  }

  const baseVersion = coreMatch[1];
  const escapedBaseVersion = baseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const packagingRevisionPattern = new RegExp(`^${escapedBaseVersion}-(\\d+)$`);
  const compatibleVersions = availableVersions
    .filter((version) => typeof version === "string")
    .map((version) => {
      if (version === baseVersion) return { revision: 0, version };
      const match = packagingRevisionPattern.exec(version);
      return match ? { revision: Number(match[1]), version } : null;
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.revision - left.revision ||
        right.version.localeCompare(left.version),
    );

  if (compatibleVersions.length === 0) {
    throw new Error(
      `No ${normalizedPackageName} version is compatible with OpenClaw ${normalizedOpenclawVersion}`,
    );
  }

  return compatibleVersions[0].version;
}

export function fetchCompatibleOfficialPluginVersion(
  packageName,
  openclawVersion,
) {
  const rawVersions = execFileSync(
    "npm",
    ["view", packageName, "versions", "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsedVersions = JSON.parse(rawVersions);
  const availableVersions = Array.isArray(parsedVersions)
    ? parsedVersions
    : [parsedVersions];
  return resolveCompatibleOfficialPluginVersion(
    packageName,
    openclawVersion,
    availableVersions,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(
      fetchCompatibleOfficialPluginVersion(process.argv[2], process.argv[3]),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
