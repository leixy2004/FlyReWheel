#!/usr/bin/env python3
"""Offline OAS 3.0 validation of rendered resources; never contacts a cluster.

Use the pinned schema cache and wheel requirements documented in the receipt.
Official schema validation is not API defaulting, semantic validation or admission.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path

import yaml
from openapi_schema_validator import OAS30Validator
from referencing import Registry

PINS = Path(__file__).with_name('kubernetes-validation-pins.json')


def reject_remote(uri):
    raise ValueError('remote schema retrieval forbidden')


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def load_validators(directory, pins):
    validators = {}
    formats = set()
    for name, pin in pins['schemas'].items():
        data = (Path(directory) / name).read_bytes()
        if len(data) > 8 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise ValueError('official schema digest mismatch')
        document = json.loads(data)
        if document.get('openapi') != '3.0.0':
            raise ValueError('expected pinned OpenAPI 3.0')
        for node in walk(document):
            if '$ref' in node and not node['$ref'].startswith('#/components/schemas/'):
                raise ValueError('nonlocal schema reference forbidden')
            if 'format' in node:
                formats.add(node['format'])
        for name, schema in document['components']['schemas'].items():
            for gvk in schema.get('x-kubernetes-group-version-kind', []):
                key = (f"{gvk['group']}/" if gvk['group'] else '') + gvk['version'], gvk['kind']
                root = {'$ref': '#/components/schemas/' + name, 'components': document['components']}
                validators.setdefault(key, OAS30Validator(root,
                    format_checker=OAS30Validator.FORMAT_CHECKER, registry=Registry(retrieve=reject_remote)))
    return validators, sorted(formats - set(OAS30Validator.FORMAT_CHECKER.checkers))


def validate_documents(documents, validators):
    if not documents:
        return [{"category": "empty-rendered-input"}]
    errors = []
    for index, document in enumerate(documents):
        if not isinstance(document, dict):
            errors.append({'document': index, 'category': 'invalid-resource'})
            continue
        key = document.get('apiVersion'), document.get('kind')
        if not all(isinstance(item, str) for item in key) or key not in validators:
            errors.append({'document': index, 'category': 'unknown-gvk'})
            continue
        # No messages, values or user-controlled field paths enter diagnostics.
        for error in validators[key].iter_errors(document):
            errors.append({'document': index, 'apiVersion': key[0], 'kind': key[1],
                           'category': str(error.validator), 'pathDepth': len(error.absolute_path)})
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--schema-dir', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('rendered', nargs='+')
    args = parser.parse_args()
    # A failed rerun must not leave a stale passing receipt at the requested path.
    Path(args.output).write_text(json.dumps({'passed': False, 'category': 'validation-incomplete', 'clusterAccess': False}) + '\n')
    pins = json.loads(PINS.read_text())
    for package, version in pins['pythonVersions'].items():
        if importlib.metadata.version(package) != version:
            raise ValueError('validator dependency version mismatch')
    validators, unvalidated_formats = load_validators(args.schema_dir, pins)
    report = {'kubernetes': pins['kubernetes'], 'sourceCommit': pins['sourceCommit'],
              'validation': 'official-openapi-3.0-offline', 'clusterAccess': False,
              'unknownFieldsRejected': False, 'unvalidatedFormats': unvalidated_formats,
              'kubernetesExtensionsEnforced': False, 'profiles': []}
    for source in args.rendered:
        data = Path(source).read_bytes()
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('rendered input bound')
        documents = list(yaml.safe_load_all(data))
        errors = validate_documents(documents, validators)
        report['profiles'].append({'file': Path(source).name, 'sha256': hashlib.sha256(data).hexdigest(),
                                   'resources': len(documents), 'errors': errors})
    report['passed'] = all(not profile['errors'] for profile in report['profiles'])
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        status = main()
    except Exception:
        print(json.dumps({'passed': False, 'category': 'validation-incomplete', 'clusterAccess': False}))
        status = 1
    raise SystemExit(status)
