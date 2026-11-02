"""Use the actual Compose parser only; never contact a Docker daemon."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('groupguard_installer_compose',Path(__file__).resolve().parents[1]/'scripts/install.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def available():
    if not shutil.which('docker'):
        return False
    return subprocess.run(['docker','compose','version'],capture_output=True,timeout=15).returncode == 0


@unittest.skipUnless(available(),'Docker Compose CLI not available; no daemon is needed')
class ActualComposeTests(unittest.TestCase):
    def check(self, text, mapped=False):
        with tempfile.TemporaryDirectory(prefix='groupguard-compose-test-') as name:
            root = Path(name)
            file = root/'compose.yaml'
            file.write_text(text,encoding='utf-8')
            context = {'project':'groupguard-synthetic','service':'yunzai','directory':root,'files':[file],'env':[]}
            before = installer.model(context)
            file.write_text(installer.patch_compose(text,'yunzai',15083,not mapped),encoding='utf-8')
            after = installer.model(context)
            installer.same_except_admin(before,after,'yunzai',15083)
            return after

    def test_mapping_environment_and_other_services(self):
        after = self.check('services:\n  yunzai:\n    image: synthetic:never-pulled\n    environment:\n      KEY: "synthetic-private"\n    ports:\n      - "127.0.0.1:1234:1234"\n  redis:\n    image: synthetic-redis:never-pulled\n')
        self.assertEqual(after['services']['yunzai']['environment']['KEY'],'synthetic-private')

    def test_list_environment(self):
        self.check('services:\n  yunzai:\n    image: synthetic:never-pulled\n    environment:\n      - KEY=synthetic-private\n      - GROUPGUARD_ADMIN_HOST=127.0.0.1\n')

    def test_other_service_depends_on_target_service(self):
        self.check('services:\n  bridge:\n    image: synthetic-bridge:never-pulled\n    depends_on:\n      yunzai:\n        condition: service_started\n  yunzai:\n    image: synthetic:never-pulled\n')

    def test_missing_fields_and_variable_references(self):
        self.check('services:\n  yunzai:\n    image: ${SYNTHETIC_IMAGE:-synthetic:never-pulled}\n    volumes:\n      - ./bot:/app\n')

    def test_existing_mapping_not_duplicated(self):
        after = self.check('services:\n  yunzai:\n    image: synthetic:never-pulled\n    ports:\n      - "127.0.0.1:15083:15083"\n',mapped=True)
        self.assertEqual(len(after['services']['yunzai']['ports']),1)

    def test_long_ports_and_quoted_service(self):
        self.check('services:\n  "yunzai":\n    image: synthetic:never-pulled\n    ports:\n      - target: 4321\n        published: "4321"\n        host_ip: "127.0.0.1"\n        protocol: tcp\n')


if __name__ == '__main__':
    unittest.main()
