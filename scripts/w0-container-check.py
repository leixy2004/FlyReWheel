"""Run only the predeclared Ruff checks inside the locked, network-none container."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

if os.getuid() != 65534 or pathlib.Path('/var/run/docker.sock').exists():
    raise SystemExit('Container identity/socket boundary failed')
manifest = json.loads(pathlib.Path('/harness/source-manifest.json').read_text())
for item in manifest:
    if hashlib.sha256((pathlib.Path('/source') / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit('Source bytes mismatch')
results = {'uid': os.getuid(), 'python': sys.version, 'sourceFilesVerified': len(manifest), 'commands': []}
commands = [
    [sys.executable, '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-cache-dir', '--no-index', '--no-deps', '--only-binary=:all:', '--require-hashes', '--find-links=/wheels', '--target=/tmp/deps', '-r', '/wheels/requirements.lock'],
    ['/tmp/deps/bin/ruff', '--version'],
    ['/tmp/deps/bin/ruff', 'format', 'httpx', 'tests', '--diff'],
    ['/tmp/deps/bin/ruff', 'check', 'httpx', 'tests'],
]
for command in commands:
    try:
        result = subprocess.run(command, cwd='/source', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'RUFF_CACHE_DIR': '/tmp/ruff-cache', 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True, timeout=60)
        row = {'command': command, 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    except subprocess.TimeoutExpired:
        row = {'command': command, 'exitCode': 124, 'stdout': '', 'stderr': '60 second timeout'}
    results['commands'].append(row)
    if len(results['commands']) == 1 and row['exitCode'] != 0:
        break
print(json.dumps(results, indent=2))
