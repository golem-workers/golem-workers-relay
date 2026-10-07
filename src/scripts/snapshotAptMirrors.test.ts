import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve("scripts/prepare-agent-server.sh"), "utf8");
const functions = script.slice(
  script.indexOf("should_use_hetzner_mirror() {"),
  script.indexOf("prepare_guest_dns_server() {"),
);

function sources(arch: string, hint: string, securityOverride = "") {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-apt-"));
  const file = join(dir, "sources.list");
  try {
    execFileSync("bash", ["-eu", "-c", `${functions}
is_hetzner_host() { return 1; }
prepare_architecture() { printf '%s' "$SNAPSHOT_TEST_ARCH"; }
configure_ubuntu_sources_list`, arch], {
      env: {
        ...process.env,
        SNAPSHOT_TEST_ARCH: arch,
        APT_SOURCES_LIST: file,
        UBUNTU_SUITE: "noble",
        APT_MIRROR_HINT: hint,
        APT_MIRROR: "",
        APT_SECURITY_MIRROR: securityOverride,
      },
      stdio: "pipe",
    });
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("snapshot apt sources", () => {
  it("keeps Hetzner regular packages but uses Ubuntu security on amd64", () => {
    const result = sources("amd64", "hetzner");
    expect(result).toContain("deb https://mirror.hetzner.com/ubuntu/packages noble ");
    expect(result).toContain("deb https://security.ubuntu.com/ubuntu noble-security ");
    expect(result).not.toContain("mirror.hetzner.com/ubuntu/security");
  });

  it("uses the official ports archive for arm64 security updates", () => {
    const result = sources("arm64", "hetzner");
    expect(result).toContain("deb https://mirror.hetzner.com/ubuntu-ports/packages noble ");
    expect(result).toContain("deb http://ports.ubuntu.com/ubuntu-ports noble-security ");
  });

  it("uses the official security archive without a Hetzner hint", () => {
    expect(sources("amd64", "")).toContain("deb https://security.ubuntu.com/ubuntu noble-security ");
  });

  it("preserves an explicit security mirror override", () => {
    expect(sources("amd64", "hetzner", "https://apt.example/security")).toContain(
      "deb https://apt.example/security noble-security ",
    );
  });
});
