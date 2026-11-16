import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('build-relay.py')


class AtomicBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts').mkdir()
        shutil.copy(SCRIPT, self.root / 'scripts/build-relay.py')
        compiler = self.root / 'node_modules/typescript/bin/tsc'
        compiler.parent.mkdir(parents=True)
        compiler.write_text('''const fs = require('fs');
const path = require('path');
const output = process.argv[process.argv.indexOf('--outDir') + 1];
fs.writeFileSync(path.join(output, 'index.js'), 'export const version = 2;');
fs.writeFileSync(path.join(output, 'bootstrap.js'), process.env.EMPTY ? '' : 'export const ready = true;');
if (process.env.FAIL) process.exit(1);
if (process.env.KILL) process.kill(process.ppid, 'SIGKILL');
''')
        (self.root / 'dist').mkdir()
        (self.root / 'dist/index.js').write_text('export const version = 1;')
        (self.root / 'dist/bootstrap.js').write_text('export const ready = true;')

    def build(self, **env):
        return subprocess.run(['python3', 'scripts/build-relay.py'], cwd=self.root,
                              env={**os.environ, **env}, capture_output=True)

    def assert_old(self):
        self.assertEqual((self.root / 'dist/index.js').read_text(), 'export const version = 1;')
        self.assertTrue((self.root / 'dist/bootstrap.js').stat().st_size)

    def test_failed_compile_preserves_live_directory(self):
        self.assertNotEqual(self.build(FAIL='1').returncode, 0)
        self.assert_old()

    def test_zero_byte_success_is_rejected(self):
        self.assertNotEqual(self.build(EMPTY='1').returncode, 0)
        self.assert_old()

    def test_killed_build_preserves_live_directory(self):
        self.assertNotEqual(self.build(KILL='1').returncode, 0)
        self.assert_old()

    def test_atomic_legacy_migration_and_repeated_publish(self):
        self.assertEqual(self.build().returncode, 0)
        dist = self.root / 'dist'
        self.assertTrue(dist.is_symlink())
        first = dist.resolve()
        self.assertEqual((dist / 'index.js').read_text(), 'export const version = 2;')
        self.assertNotEqual(self.build(FAIL='1').returncode, 0)
        self.assertEqual(dist.resolve(), first)
        self.assertEqual(self.build().returncode, 0)
        self.assertNotEqual(dist.resolve(), first)
        self.assertTrue((first / 'index.js').exists())
        retained = list((self.root / '.relay-builds').glob('*.link'))
        self.assertEqual(len(retained), 1)
        self.assertEqual((retained[0] / 'index.js').read_text(), 'export const version = 1;')

    def test_missing_entrypoint_preserves_live_directory(self):
        compiler = self.root / 'node_modules/typescript/bin/tsc'
        compiler.write_text('')
        self.assertNotEqual(self.build().returncode, 0)
        self.assert_old()


if __name__ == '__main__':
    unittest.main()
