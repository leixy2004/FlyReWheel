"""Offline tests using the verified official schema cache, not a cluster."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('kube_validation', ROOT / 'deploy/validate-kubernetes.py')
kube = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kube)
CACHE = Path(sys.argv.pop(1))
PINS = json.loads(kube.PINS.read_text())


class OfficialSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validators, cls.formats = kube.load_validators(CACHE, PINS)
        cls.base = list(yaml.safe_load_all((CACHE / 'base.yaml').read_text()))
        cls.dev = list(yaml.safe_load_all((CACHE / 'single-node-dev.yaml').read_text()))

    def test_actual_rendered_resources(self):
        self.assertEqual(len(self.base), 10)
        self.assertEqual(len(self.dev), 19)
        self.assertEqual(kube.validate_documents(self.base + self.dev, self.validators), [])

    def test_rejects_official_type_required_and_union_violations(self):
        source = next(d for d in self.base if d['kind'] == 'Deployment')
        for mutate in (
            lambda d: d['spec'].update(replicas='one-sensitive-fixture'),
            lambda d: d['spec']['template']['spec']['containers'][0]['ports'][0].update(containerPort='8080'),
            lambda d: d['spec']['template']['spec']['containers'][0].pop('name'),
            lambda d: d['spec']['template']['spec']['containers'][0]['readinessProbe']['httpGet'].update(port=True),
        ):
            item = copy.deepcopy(source)
            mutate(item)
            errors = kube.validate_documents([item], self.validators)
            self.assertTrue(errors)
            self.assertNotIn('sensitive-fixture', json.dumps(errors))

    def test_rejects_network_policy_type_error(self):
        item = copy.deepcopy(next(d for d in self.base if d['kind'] == 'NetworkPolicy'))
        item['spec']['policyTypes'] = [123]
        self.assertTrue(kube.validate_documents([item], self.validators))

    def test_unknown_gvk_and_non_object_fail_closed(self):
        self.assertEqual([e['category'] for e in kube.validate_documents(
            [{'apiVersion': 'unknown', 'kind': 'Secret'}, None], self.validators)],
            ['unknown-gvk', 'invalid-resource'])

    def test_schema_tampering_is_rejected_before_validation(self):
        bad = copy.deepcopy(PINS)
        next(iter(bad['schemas'].values()))['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            kube.load_validators(CACHE, bad)

    def test_remote_refs_are_rejected_even_with_matching_fixture_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            content = json.dumps({'openapi': '3.0.0', 'components': {'schemas': {'Fixture': {
                '$ref': 'https://forbidden.invalid/schema'}}}}).encode()
            Path(temporary, 'fixture.json').write_bytes(content)
            with self.assertRaisesRegex(ValueError, 'nonlocal'):
                kube.load_validators(temporary, {'schemas': {'fixture.json': {
                    'sha256': hashlib.sha256(content).hexdigest()}}})
        with self.assertRaisesRegex(ValueError, 'remote'):
            kube.reject_remote('https://forbidden.invalid')

    def test_empty_render_is_not_a_pass(self):
        self.assertEqual(kube.validate_documents([], self.validators),
                         [{'category': 'empty-rendered-input'}])

    def test_malformed_yaml_never_echoes_secret_shaped_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary, 'malformed.yaml')
            source.write_text('data: [fixture-sensitive-value\n')
            Path(temporary, 'result.json').write_text('{"passed": true}')
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'deploy/validate-kubernetes.py'),
                '--schema-dir', str(CACHE), '--output', str(Path(temporary, 'result.json')), str(source)],
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(Path(temporary, 'result.json').read_text())['passed'])
            self.assertNotIn('fixture-sensitive-value', result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)['category'], 'validation-incomplete')

    def test_format_and_unknown_field_limits_are_explicit(self):
        self.assertEqual(self.formats, ['int-or-string'])
        # Official schema permits unknown fields; do not pretend it is admission.
        item = copy.deepcopy(self.base[0])
        item['fixtureUnknown'] = 'allowed-by-official-schema'
        self.assertEqual(kube.validate_documents([item], self.validators), [])


if __name__ == '__main__':
    unittest.main()
