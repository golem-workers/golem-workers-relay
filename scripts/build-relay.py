#!/usr/bin/env python3
"""Compile off-line and atomically publish an immutable Relay generation.

Never compile into dist: an interrupted write can truncate a live ES module.
Old generations intentionally remain available to processes using their realpaths.
"""
import ctypes
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def publish(root, generation):
    dist = root / 'dist'
    link = generation.parent / (generation.name + '.link')
    link.symlink_to(os.path.relpath(generation, root))
    # The relative target is interpreted from dist's final location, not staging.
    try:
        if dist.is_dir() and not dist.is_symlink():
            # One-time migration from a legacy directory, with no missing-dist gap.
            # Refuse on unsupported hosts/filesystems; never fall back to delete+move.
            libc = ctypes.CDLL(None, use_errno=True)
            exchange = getattr(libc, 'renameat2', None)
            if exchange is not None:
                status = exchange(-100, os.fsencode(link), -100, os.fsencode(dist), 2)
            elif hasattr(libc, 'renamex_np'):  # macOS RENAME_SWAP
                status = libc.renamex_np(os.fsencode(link), os.fsencode(dist), 2)
            else:
                raise RuntimeError('Atomic legacy dist migration is unavailable')
            if status:
                err = ctypes.get_errno()
                raise OSError(err, os.strerror(err))
            # link now contains the old directory; retain it for rollback.
        else:
            os.replace(link, dist)
    finally:
        if link.is_symlink():
            link.unlink()


def main():
    root = Path(__file__).resolve().parent.parent
    builds = root / '.relay-builds'
    builds.mkdir(exist_ok=True)
    with (builds / 'build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        generation = Path(tempfile.mkdtemp(prefix='generation-', dir=builds))
        try:
            subprocess.run(['node', 'node_modules/typescript/bin/tsc', '-p',
                            'tsconfig.build.json', '--outDir', str(generation),
                            '--noEmitOnError'], cwd=root, check=True)
            modules = list(generation.rglob('*.js'))
            if not (generation / 'index.js').is_file() or not modules:
                raise RuntimeError('Missing Relay entrypoint/build output')
            for module in modules:
                if not module.stat().st_size:
                    raise RuntimeError(f'Empty compiled module: {module.relative_to(generation)}')
            publish(root, generation)
        except BaseException:
            # An installed generation must never be removed after a successful swap.
            if not (root / 'dist').is_symlink() or (root / 'dist').resolve() != generation:
                shutil.rmtree(generation, ignore_errors=True)
            raise


if __name__ == '__main__':
    main()
