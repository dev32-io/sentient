"""Offline provisioning contract; synthetic credentials and self-signed certificates only."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/bake-creds.sh'


class BakeCredsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'firmware/main').mkdir(parents=True)
        shutil.copy2(SCRIPT, self.root / 'scripts/bake-creds.sh')
        self.cert = self.root / 'outward.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(self.root / 'key.pem'), '-out', str(self.cert),
                        '-days', '1', '-subj', '/CN=cube.local',
                        '-addext', 'subjectAltName=IP:192.168.12.5,DNS:cube.local'],
                       check=True, capture_output=True)
        self.data = dict(WIFI_SSID='Lab "Cube"', WIFI_PSK='back\\slash\npass',
                         PASETO_TOKEN='v4.local.' + 'a' * 60, DEVICE_ID='test-device',
                         GATEWAY_HOST='192.168.12.5', GATEWAY_WS_PORT=443,
                         GATEWAY_WS_PATH='/api/v1/ws', TRUSTED_CERT_PATH=str(self.cert))
        self.input = self.root / 'provision.json'
        self.write_input()

    def write_input(self):
        self.input.write_text(json.dumps(self.data))
        self.input.chmod(0o600)

    def run_bake(self, *args, env=None):
        return subprocess.run(['bash', str(self.root / 'scripts/bake-creds.sh'), *args],
                              capture_output=True, text=True, env=env)

    def make_cert(self, san=None, future=False):
        if not future:
            cmd = ['openssl', 'req', '-x509', '-new', '-key', str(self.root / 'key.pem'),
                   '-out', str(self.cert), '-days', '1', '-subj', '/CN=cube.local']
            if san:
                cmd += ['-addext', f'subjectAltName={san}']
            subprocess.run(cmd, check=True, capture_output=True)
            return
        csr = self.root / 'request.pem'
        subprocess.run(['openssl', 'req', '-new', '-key', str(self.root / 'key.pem'),
                        '-out', str(csr), '-subj', '/CN=cube.local'], check=True, capture_output=True)
        (self.root / 'newcerts').mkdir()
        (self.root / 'index.txt').touch()
        (self.root / 'serial').write_text('01\n')
        config = self.root / 'ca.cnf'
        config.write_text(f'''[ca]
default_ca = local
[local]
database = {self.root / 'index.txt'}
serial = {self.root / 'serial'}
new_certs_dir = {self.root / 'newcerts'}
default_md = sha256
policy = policy
x509_extensions = extensions
[policy]
commonName = supplied
[extensions]
subjectAltName = IP:192.168.12.5,DNS:cube.local
''')
        start = datetime.now(timezone.utc) + timedelta(days=2)
        end = start + timedelta(days=1)
        subprocess.run(['openssl', 'ca', '-selfsign', '-batch', '-config', str(config),
                        '-keyfile', str(self.root / 'key.pem'), '-in', str(csr),
                        '-out', str(self.cert), '-startdate', start.strftime('%Y%m%d%H%M%SZ'),
                        '-enddate', end.strftime('%Y%m%d%H%M%SZ')], check=True, capture_output=True)

    def test_explicit_success_escapes_strings_and_replaces_placeholder(self):
        out = self.root / 'firmware/main'
        (out / 'sentient_creds.h').write_text('COMPILE_ONLY_PLACEHOLDER')
        result = self.run_bake('--input', str(self.input))
        self.assertEqual(result.returncode, 0, result.stderr)
        header = (out / 'sentient_creds.h').read_text()
        self.assertNotIn('COMPILE_ONLY_PLACEHOLDER', header)
        self.assertIn('SENTIENT_DEV_TLS_PIN      1', header)
        self.assertIn('SENTIENT_PRESERVE_WIFI    0', header)
        self.assertIn('SENTIENT_GATEWAY_WS_PORT  443', header)
        self.assertIn('Lab \\"Cube\\"', header)
        self.assertIn(r'back\\slash\012pass', header)
        self.assertIn(self.data['PASETO_TOKEN'], header)
        self.assertEqual(stat.S_IMODE((out / 'sentient_creds.h').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((out / 'sentient_dev_gateway.crt').stat().st_mode), 0o600)
        self.assertTrue((out / 'sentient_dev_gateway.crt').read_text().startswith('-----BEGIN CERTIFICATE-----'))
        self.assertNotIn(self.data['PASETO_TOKEN'], result.stdout + result.stderr)
        self.assertNotIn(self.data['WIFI_PSK'], result.stdout + result.stderr)

    def test_preserve_wifi_emits_no_wifi_credentials(self):
        wifi_values = (self.data.pop('WIFI_SSID'), self.data.pop('WIFI_PSK'))
        self.data['PRESERVE_WIFI'] = True
        self.write_input()
        result = self.run_bake('--input', str(self.input))
        self.assertEqual(result.returncode, 0, result.stderr)
        header = (self.root / 'firmware/main/sentient_creds.h').read_text()
        self.assertIn('#define SENTIENT_PRESERVE_WIFI    1', header)
        self.assertNotIn('SENTIENT_WIFI_SSID', header)
        self.assertNotIn('SENTIENT_WIFI_PSK', header)
        for value in wifi_values:
            self.assertNotIn(value, header)
        self.assertIn(self.data['PASETO_TOKEN'], header)
        self.assertIn('SENTIENT_DEV_TLS_PIN      1', header)
        self.assertTrue((self.root / 'firmware/main/sentient_dev_gateway.crt').exists())

    def test_preserve_wifi_still_requires_token_and_trusted_cert(self):
        self.data.pop('WIFI_SSID')
        self.data.pop('WIFI_PSK')
        self.data['PRESERVE_WIFI'] = True
        out = self.root / 'firmware/main/sentient_creds.h'
        for key, bad_value in (('PASETO_TOKEN', 'invalid'), ('TRUSTED_CERT_PATH', '/missing.pem')):
            with self.subTest(key=key):
                data = self.data.copy()
                data[key] = bad_value
                self.input.write_text(json.dumps(data))
                self.assertNotEqual(self.run_bake('--input', str(self.input)).returncode, 0)
                self.assertFalse(out.exists())

    def test_rejects_ambiguous_or_missing_wifi_mode_without_overwrite(self):
        out = self.root / 'firmware/main/sentient_creds.h'
        out.write_text('COMPILE_ONLY_PLACEHOLDER')
        original = self.data.copy()
        for changes in ({'PRESERVE_WIFI': True}, {'PRESERVE_WIFI': False},
                        {'PRESERVE_WIFI': 'true'}, {'WIFI_PSK': None},
                        {'WIFI_SSID': None}, {'WIFI_SSID': None, 'WIFI_PSK': None},
                        {'WIFI_SSID': None, 'WIFI_PSK': None, 'PRESERVE_WIFI': False},
                        {'WIFI_SSID': None, 'WIFI_PSK': None, 'PRESERVE_WIFI': 1}):
            with self.subTest(changes=changes):
                data = original.copy()
                for key, value in changes.items():
                    if value is None:
                        data.pop(key)
                    else:
                        data[key] = value
                self.data = data
                self.write_input()
                result = self.run_bake('--input', str(self.input))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(out.read_text(), 'COMPILE_ONLY_PLACEHOLDER')
                self.assertFalse((out.parent / 'sentient_dev_gateway.crt').exists())

    def test_rejects_missing_input_prod_and_insecure_input_without_overwrite(self):
        out = self.root / 'firmware/main/sentient_creds.h'
        out.write_text('COMPILE_ONLY_PLACEHOLDER')
        for args in ((), ('--input', str(self.input), '--profile', 'prod')):
            self.assertNotEqual(self.run_bake(*args).returncode, 0)
            self.assertEqual(out.read_text(), 'COMPILE_ONLY_PLACEHOLDER')
        self.input.chmod(0o644)
        self.assertNotEqual(self.run_bake('--input', str(self.input)).returncode, 0)
        self.assertEqual(out.read_text(), 'COMPILE_ONLY_PLACEHOLDER')

    def test_rejects_missing_fields_bad_host_and_cert_mismatch(self):
        out = self.root / 'firmware/main/sentient_creds.h'
        for change in ({'PASETO_TOKEN': ''}, {'GATEWAY_HOST': 'example.com'},
                       {'GATEWAY_HOST': '192.168.12.6'}, {'GATEWAY_WS_PATH': '//evil'}):
            data = self.data.copy()
            data.update(change)
            self.input.write_text(json.dumps(data))
            result = self.run_bake('--input', str(self.input))
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(self.data['PASETO_TOKEN'], result.stdout + result.stderr)
            self.assertNotIn(self.data['WIFI_PSK'], result.stdout + result.stderr)
            self.assertFalse(out.exists())
        self.input.write_text(json.dumps(self.data))
        self.data['GATEWAY_HOST'] = 'cube.local'
        self.write_input()
        self.assertEqual(self.run_bake('--input', str(self.input)).returncode, 0)

    def test_rejects_future_cert_without_overwriting_pair(self):
        self.assertEqual(self.run_bake('--input', str(self.input)).returncode, 0)
        out = self.root / 'firmware/main'
        old = {name: (out / name).read_bytes() for name in ('sentient_dev_gateway.crt', 'sentient_creds.h')}
        self.make_cert(future=True)
        result = self.run_bake('--input', str(self.input))
        self.assertNotEqual(result.returncode, 0)
        for name, content in old.items():
            self.assertEqual((out / name).read_bytes(), content)

    def test_rejects_cn_only_and_wrong_type_san(self):
        self.data['GATEWAY_HOST'] = 'cube.local'
        self.write_input()
        for san in (None, 'IP:192.168.12.5', 'DNS:other.local'):
            self.make_cert(san=san)
            result = self.run_bake('--input', str(self.input))
            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertFalse((self.root / 'firmware/main/sentient_creds.h').exists())

    def test_second_publication_failure_restores_prior_pair(self):
        self.assertEqual(self.run_bake('--input', str(self.input)).returncode, 0)
        out = self.root / 'firmware/main'
        old = {name: (out / name).read_bytes() for name in ('sentient_dev_gateway.crt', 'sentient_creds.h')}
        self.data['DEVICE_ID'] = 'new-device'
        self.write_input()
        self.make_cert(san='IP:192.168.12.5,DNS:cube.local')
        # Isolated fault injection: only header replacement fails, rollback remains possible.
        (self.root / 'sitecustomize.py').write_text('''import os
_original = os.replace
def fail_header(source, destination):
    if str(destination).endswith('/sentient_creds.h'):
        raise OSError('injected publication failure')
    return _original(source, destination)
os.replace = fail_header
''')
        result = self.run_bake('--input', str(self.input),
                               env={**os.environ, 'PYTHONPATH': str(self.root)})
        self.assertNotEqual(result.returncode, 0)
        for name, content in old.items():
            self.assertEqual((out / name).read_bytes(), content)
        self.assertFalse(list(out.glob('.bake-*')))

    def test_no_automatic_network_or_mint_path(self):
        text = SCRIPT.read_text()
        for forbidden in ('s_client', 'mint-cube-token', '.e2e-testing', 'ipconfig', 'route -n'):
            self.assertNotIn(forbidden, text)


if __name__ == '__main__':
    unittest.main()
