"""Execute only the frozen Ruff checks from a verified read-only image tool path."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

side, expected_hash = sys.argv[1:]
tool = '/opt/ruff/' + side
mounts = pathlib.Path('/proc/self/mountinfo').read_text().splitlines()
tmp_mount = next(line for line in mounts if line.split()[4] == '/tmp')
if os.getuid() != 65534 or 'noexec' not in tmp_mount.split()[5].split(','):
    raise SystemExit('Non-root/noexec boundary failed')
if hashlib.sha256(pathlib.Path(tool).read_bytes()).hexdigest() != expected_hash:
    raise SystemExit('Tool hash mismatch')
files = json.loads(pathlib.Path('/harness/source-manifest.json').read_text())
for item in files:
    if hashlib.sha256((pathlib.Path('/source') / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit('Source bytes mismatch')
print(json.dumps({'kind': 'preflight', 'uid': os.getuid(), 'toolHash': expected_hash, 'toolMode': oct(os.stat(tool).st_mode),
                  'tmpMount': tmp_mount, 'sourceFilesVerified': len(files), 'python': sys.version}), flush=True)
for args in [['--version'], ['format', 'httpx', 'tests', '--diff'], ['check', 'httpx', 'tests']]:
    command = [tool] + args
    try:
        result = subprocess.run(command, cwd='/source', env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'RUFF_CACHE_DIR': '/tmp/ruff-cache'}, capture_output=True, text=True, timeout=60)
        row = {'kind': 'command', 'command': command, 'exitCode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr}
    except (OSError, subprocess.TimeoutExpired) as e:
        row = {'kind': 'command', 'command': command, 'exitCode': None, 'error': str(e)}
    print(json.dumps(row), flush=True)
    if row['exitCode'] is None:
        break
for item in files:
    if hashlib.sha256((pathlib.Path('/source') / item['path']).read_bytes()).hexdigest() != item['sha256']:
        raise SystemExit('Source changed')
print(json.dumps({'kind': 'postflight', 'sourceBytesUnchanged': True}), flush=True)
