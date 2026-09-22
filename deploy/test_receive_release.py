import importlib.util
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('receive', Path(__file__).with_name('receive-release.py'))
receive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receive)


class ArchiveSafety(unittest.TestCase):
    def test_code_and_frontend_data_allowed(self):
        receive.validate_members([tarfile.TarInfo(n) for n in ['dist/index.html', 'server/index.ts', 'src/data/metrics.ts', 'package.json']])

    def test_private_and_escape_paths_rejected(self):
        for name in ['../.env.local', '/root/a', 'data/workspace.json', '.env.local', 'server/../../.env.local', 'src/.env.local', 'deploy/receive-release.py']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                receive.validate_members([tarfile.TarInfo(name)])

    def test_links_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE]:
            member = tarfile.TarInfo('server/link')
            member.type = kind
            with self.assertRaises(ValueError):
                receive.validate_members([member])

    def test_size_limit(self):
        member = tarfile.TarInfo('dist/large')
        member.size = receive.LIMIT + 1
        with self.assertRaises(ValueError):
            receive.validate_members([member])
