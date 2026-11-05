#!/usr/bin/env python3
"""Stage a Git tree before atomically replacing individual live Relay files.

A failed checkout must never truncate the systemd launcher or the running updater.
This is file-level promotion, not a transaction across code, dependencies and dist.
"""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


CRITICAL_SCRIPTS = ("scripts/start.sh", "scripts/update-repo.sh")
PRIVATE_ROOTS = {".env", "node_modules", "logs", "pids", ".git"}


def git(repo, *args, env=None):
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env)


def tree_paths(repo, revision):
    return [os.fsdecode(p) for p in git(repo, "ls-tree", "-rz", "--name-only", revision).split(b"\0") if p]


def validate_destination(repo, name):
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or path.parts[0] in PRIVATE_ROOTS:
        raise ValueError("Refusing reserved Relay path: " + name)
    # Never follow a live directory symlink into private state or outside the repo.
    for parent in path.parents:
        if parent == Path("."):
            continue
        dest = repo / parent
        if dest.is_symlink() or (dest.exists() and not dest.is_dir()):
            raise ValueError("Unsafe live parent for Relay path: " + name)
    dest = repo / path
    if dest.is_dir() and not dest.is_symlink():
        raise ValueError("Refusing to replace a live directory: " + name)


def install(repo, revision):
    repo = Path(repo).resolve()
    target = git(repo, "rev-parse", "--verify", revision + "^{commit}").decode().strip()
    paths = tree_paths(repo, target)
    previous = tree_paths(repo, "HEAD")
    # The temporary index prevents checkout from touching the active worktree.
    # Keep staging on the same filesystem so each promotion is one rename.
    with tempfile.TemporaryDirectory(prefix=".relay-stage-", dir=repo) as temporary:
        stage = Path(temporary)
        tree = stage / "tree"
        tree.mkdir()
        env = {**os.environ, "GIT_INDEX_FILE": str(stage / "index")}
        git(repo, "read-tree", target, env=env)
        git(repo, "checkout-index", "--all", "--force", "--prefix=" + str(tree) + "/", env=env)
        for name in CRITICAL_SCRIPTS:
            script = tree / name
            if script.is_symlink() or not script.is_file() or not script.read_bytes().startswith(b"#!/usr/bin/env bash\n"):
                raise ValueError("Invalid staged Relay executable: " + name)
            subprocess.run(["bash", "-n", str(script)], check=True)
        for name in paths:
            validate_destination(repo, name)
            source = tree / name
            if not source.is_symlink():
                # Detect delayed write failures while the old live files are intact.
                with source.open("rb") as handle:
                    os.fsync(handle.fileno())
        removed = set(previous) - set(paths)
        for name in removed:
            validate_destination(repo, name)
        diff = subprocess.run(["git", "-C", str(repo), "diff", "--quiet", target, "--"])
        if diff.returncode not in (0, 1):
            raise RuntimeError("Unable to inspect live Relay tree")
        changed = diff.returncode == 1
        if changed:
            for name in paths:
                source, destination = tree / name, repo / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                # No open(O_TRUNC), redirection or copy onto a live executable.
                os.replace(source, destination)
                fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            for name in removed:
                (repo / name).unlink(missing_ok=True)
        # --mixed updates Git metadata only; --hard would reintroduce live truncation.
        git(repo, "reset", "--mixed", target)
        print("__GW_RELAY_FILES_CHANGED__=" + ("1" if changed else "0"))


if __name__ == "__main__":
    try:
        install(sys.argv[1], sys.argv[2])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print("Relay tree installation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
