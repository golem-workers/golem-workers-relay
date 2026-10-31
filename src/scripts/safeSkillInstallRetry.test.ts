import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(process.cwd(), "scripts/prepare-agent-server.sh"), "utf8")
  .replace(/\nmain "\$@"\s*$/, "");

function install(failures: number, message: string) {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, MOCK_FAILURES: String(failures), MOCK_ERROR: message },
    input: `${script}
attempts=0
openclaw() {
  attempts=$((attempts + 1))
  echo "call:$*"
  if (( attempts <= MOCK_FAILURES )); then echo "$MOCK_ERROR"; return 23; fi
  echo 'Installed trusted skill'
}
sleep() { echo "backoff:$1"; }
if install_openclaw_safe_skill '@ivangdavila/powerpoint-pptx'; then code=0; else code=$?; fi
echo "attempts:$attempts"
exit "$code"
`,
  });
}

const unavailable = 'ClawHub release trust check failed: ClawHub /api/v1/skills/-/security-verdicts failed (500): Server Error';

describe("snapshot safe-skill installation retry", () => {
  it("retries a transient verdict HTTP 5xx with the same unmodified CLI gate", () => {
    const result = install(2, unavailable);
    expect(result.status).toBe(0);
    expect(result.stdout.match(/call:skills install @ivangdavila\/powerpoint-pptx/g)).toHaveLength(3);
    expect(result.stdout).toContain("backoff:5");
    expect(result.stdout).toContain("backoff:10");
    expect(result.stdout).toContain("Installed trusted skill");
    expect(result.stdout.match(/Server Error/g)).toHaveLength(2);
  });

  it("retains the actual failure code after four failed verdict attempts", () => {
    const result = install(8, unavailable.replace("(500)", "(503)"));
    expect(result.status).toBe(23);
    expect(result.stdout).toContain("attempts:4");
    expect(result.stdout.match(/backoff:/g)).toHaveLength(3);
    expect(result.stdout).not.toContain("Installed trusted skill");
  });

  it.each([
    "ClawHub blocked this release; install was not started.",
    unavailable.replace("(500)", "(403)"),
    unavailable.replace("(500)", "(429)"),
    "ClawHub /api/v1/download failed (500): Server Error",
    "Archive integrity mismatch",
  ])("does not retry a trust rejection or unrelated failure: %s", (message) => {
    const result = install(8, message);
    expect(result.status).toBe(23);
    expect(result.stdout).toContain("attempts:1");
    expect(result.stdout).not.toContain("backoff:");
  });
});
