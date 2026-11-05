import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const updater = readFileSync(resolve("scripts/update-repo.sh"), "utf8");
const helperPath = resolve("scripts/install-relay-tree.py");
const start = "#!/usr/bin/env bash\nprintf 'old launcher\\n'\n";
const nextStart = "#!/usr/bin/env bash\nprintf 'new launcher\\n'\n";
const compiler = spawnSync("cc", ["--version"]).status === 0;

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture(newStart = nextStart) {
  const root = mkdtempSync(join(tmpdir(), "relay-atomic-")); roots.push(root);
  const source = join(root, "source"), live = join(root, "live");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "scripts/start.sh"), start, { mode: 0o755 });
  writeFileSync(join(source, "scripts/update-repo.sh"), updater, { mode: 0o755 });
  if (existsSync(helperPath)) writeFileSync(join(source, "scripts/install-relay-tree.py"), readFileSync(helperPath));
  git(source, "init", "-b", "main"); git(source, "config", "user.email", "fixture@example.invalid"); git(source, "config", "user.name", "Fixture");
  git(source, "add", "."); git(source, "commit", "-m", "old");
  const oldHead = git(source, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", source, live]);
  writeFileSync(join(source, "scripts/start.sh"), newStart);
  writeFileSync(join(source, "scripts/update-repo.sh"), updater + "\n# next revision\n");
  git(source, "add", "."); git(source, "commit", "-m", "new");
  const newHead = git(source, "rev-parse", "HEAD");
  const npm = join(root, "npm");
  writeFileSync(npm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_RECEIPT\"\n", { mode: 0o755 });
  writeFileSync(join(live, ".env"), "FIXTURE=inert\n");
  return { root, source, live, npm, oldHead, newHead };
}
function run(f: ReturnType<typeof fixture>, extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", [join(f.live, "scripts/update-repo.sh")], {
    encoding: "utf8", timeout: 20000,
    env: { ...process.env, NODE_USE_ENV_PROXY: "0", SERVICE_NAME: "", APP_GIT_REF: "main", NODE_ENV: "development", NPM_BIN: f.npm, NPM_RECEIPT: join(f.root, "npm-receipt"), ...extra },
  });
}
function fault(f: ReturnType<typeof fixture>, kind = "space") {
  const c = join(f.root, "fault.c"), so = join(f.root, "fault.so");
  // Git's real checkout writes fail after opening/truncating a script. Staging
  // must absorb the same failure without changing either live executable.
  writeFileSync(c, `#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <signal.h>
ssize_t write(int fd, const void *buf, size_t n) {
 char link[80], path[4096]; snprintf(link,sizeof(link),"/proc/self/fd/%d",fd);
 ssize_t len=readlink(link,path,sizeof(path)-1);
 if(len>0) { path[len]=0;
  if(strstr(path,"/scripts/start.sh") || strstr(path,"/scripts/update-repo.sh")) {
   ${kind === "kill" ? "raise(SIGKILL);" : "errno=ENOSPC; return -1;"}
  }
 }
 ssize_t (*real_write)(int,const void*,size_t)=dlsym(RTLD_NEXT,"write");
 return real_write(fd,buf,n);
}
`);
  execFileSync("cc", ["-shared", "-fPIC", "-o", so, c, "-ldl"]);
  return { LD_PRELOAD: so };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Relay updater preserves live executables", () => {
  it.skipIf(!compiler)("keeps the old tree and HEAD when checkout hits ENOSPC", () => {
    const f = fixture(); const result = run(f, fault(f));
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(start);
    expect(readFileSync(join(f.live, "scripts/update-repo.sh"), "utf8")).toBe(updater);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(f.oldHead);
    expect(existsSync(join(f.root, "npm-receipt"))).toBe(false);
  });
  it.skipIf(!compiler)("keeps both launchers when checkout is killed during a script write", () => {
    const f = fixture(); const result = run(f, fault(f, "kill"));
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(start);
    expect(readFileSync(join(f.live, "scripts/update-repo.sh"), "utf8")).toBe(updater);
  });
  it.each(["", "#!/usr/bin/env bash\nif then\n", "printf 'missing interpreter\\n'\n"])("rejects an invalid fetched launcher (%j) before promotion", invalid => {
    const f = fixture(invalid); const result = run(f);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(start);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(f.oldHead);
    expect(existsSync(join(f.root, "npm-receipt"))).toBe(false);
  });
  it("rejects an invalid fetched updater before replacing the launcher", () => {
    const f = fixture();
    writeFileSync(join(f.source, "scripts/update-repo.sh"), "");
    git(f.source, "add", "."); git(f.source, "commit", "-m", "invalid updater");
    expect(run(f).status).not.toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(start);
    expect(readFileSync(join(f.live, "scripts/update-repo.sh"), "utf8")).toBe(updater);
  });
  it("rejects a fetched launcher symlink", () => {
    const f = fixture();
    rmSync(join(f.source, "scripts/start.sh"));
    symlinkSync("update-repo.sh", join(f.source, "scripts/start.sh"));
    git(f.source, "add", "."); git(f.source, "commit", "-m", "symlink launcher");
    expect(run(f).status).not.toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(start);
  });
  it("retries an unfinished build after HEAD has already advanced", () => {
    const f = fixture();
    writeFileSync(f.npm, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(run(f).status).not.toBe(0);
    expect(git(f.live, "rev-parse", "HEAD")).toBe(f.newHead);
    writeFileSync(f.npm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_RECEIPT\"\n", { mode: 0o755 });
    expect(run(f).status).toBe(0);
    expect(readFileSync(join(f.root, "npm-receipt"), "utf8")).toBe("ci\nrun build\n");
    expect(existsSync(join(f.live, "pids/relay-build.pending"))).toBe(false);
  });
  it("promotes valid files, preserves private state and rebuilds once", () => {
    const f = fixture(); const result = run(f);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(nextStart);
    expect(readFileSync(join(f.live, ".env"), "utf8")).toBe("FIXTURE=inert\n");
    expect(git(f.live, "rev-parse", "HEAD")).toBe(f.newHead);
    expect(readFileSync(join(f.root, "npm-receipt"), "utf8")).toBe("ci\nrun build\n");
    expect(run(f).status).toBe(0);
    expect(readFileSync(join(f.root, "npm-receipt"), "utf8")).toBe("ci\nrun build\n");
  });
  it("repairs a zero-byte tracked launcher at the same commit and rebuilds", () => {
    const f = fixture(); expect(run(f).status).toBe(0);
    writeFileSync(join(f.live, "scripts/start.sh"), "");
    const result = run(f);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.live, "scripts/start.sh"), "utf8")).toBe(nextStart);
    expect(readFileSync(join(f.root, "npm-receipt"), "utf8")).toBe("ci\nrun build\nci\nrun build\n");
  });
});
