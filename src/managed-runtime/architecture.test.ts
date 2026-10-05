import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
it("keeps relay runtime metadata writers canonical and excludes relay environment authority", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(new URL("../", import.meta.url), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name === "policy.generated.ts") continue;
    const file = join(entry.parentPath, entry.name), source = readFileSync(file, "utf8");
    if (/\.agentRuntime\s*=(?!=)|\.agentRuntime\s*\?\?=|agentRuntime\s*:\s*\{\s*id\s*:|\bruntime\.id\s*=(?!=)|policyFromEnvironment\(|process\.env\.MANAGED_AGENT_HARNESS/.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
