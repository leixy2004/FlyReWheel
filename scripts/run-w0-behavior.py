"""Consume frozen local W0 exports/wheels; no pulls, downloads, builds or retries."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import time

STAGE = pathlib.Path('/tmp/flyrewheel-w0-behavior-attempt-1')
CONTEXT = pathlib.Path('/tmp/flyrewheel-w0-full-context-attempt-1')
IMAGE = 'sha256:d3846bce6e97d0ef5c32fc023300d5e39251ad791e6fdfaee41d2ba75246766e'
REPO = pathlib.Path(__file__).resolve().parents[1]
acquisition = json.loads((STAGE / 'dependency-acquisition.json').read_text())
reports = []
for side in ['before', 'after']:
    saved = json.loads((CONTEXT / f'context-3031-{side}.json').read_text())
    source = CONTEXT / 'exports' / ('export-' + saved['binding']['requestDigest']) / 'repo'
    work = STAGE / ('run-readable-' + side)
    work.mkdir()  # Exclusive; do not retry an existing attempt.
    copied = work / 'source'
    copied.mkdir()
    files = []
    for p in sorted(source.rglob('*')):
        rel = p.relative_to(source)
        if '.git' in rel.parts or not p.is_file():
            continue
        if p.is_symlink():
            raise RuntimeError('Symlink source rejected')
        dest = copied / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)
        dest.chmod(0o444)
        files.append({'path': str(rel), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()})
    harness = work / 'harness'
    harness.mkdir()
    shutil.copyfile(REPO / 'scripts/w0-container-check.py', harness / 'runner.py')
    (harness / 'source-manifest.json').write_text(json.dumps(files, indent=2) + '\n')
    wheel_record = next(x for x in acquisition if x['name'] == 'ruff-' + side)
    wheels = STAGE / wheel_record['name']
    if wheel_record['exitCode'] != 0 or len(wheel_record['wheels']) != 1:
        raise RuntimeError('Frozen dependency unavailable')
    wheel = wheel_record['wheels'][0]
    if hashlib.sha256((wheels / wheel['file']).read_bytes()).hexdigest() != wheel['sha256']:
        raise RuntimeError('Wheel hash mismatch')
    (wheels / 'requirements.lock').write_text(wheel_record['requirements'][0] + ' --hash=sha256:' + wheel['sha256'] + '\n')
    # Readable staging is still exposed only through read-only container mounts.
    for directory in [work, copied, harness, wheels]:
        directory.chmod(0o755)
        for child in directory.rglob('*'):
            child.chmod(0o755 if child.is_dir() else 0o444)
    name = 'flyrewheel-w0-ruff-readable-' + side
    args = ['docker', 'create', '--pull=never', '--name', name, '--user', '65534:65534', '--network=none', '--read-only',
            '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=64', '--cpus=1', '--memory=512m', '--memory-swap=512m',
            '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777', '--workdir=/source', '--entrypoint=/usr/local/bin/python',
            '--mount', f'type=bind,src={copied},dst=/source,readonly', '--mount', f'type=bind,src={harness},dst=/harness,readonly',
            '--mount', f'type=bind,src={wheels},dst=/wheels,readonly', IMAGE, '-I', '/harness/runner.py']
    started = time.time()
    created = subprocess.run(args, capture_output=True, text=True, timeout=30)
    row = {'side': side, 'commit': saved['sha'], 'tree': saved['tree'], 'imageId': IMAGE, 'sourceFileCount': len(files), 'createArgs': args,
           'createExit': created.returncode, 'createDiagnostic': created.stderr, 'created': created.returncode == 0}
    if created.returncode == 0:
        cid = created.stdout.strip()
        try:
            inspected = json.loads(subprocess.check_output(['docker', 'inspect', cid], text=True))[0]
            h = inspected['HostConfig']
            assert h['NetworkMode'] == 'none' and h['ReadonlyRootfs'] and h['CapDrop'] == ['ALL']
            assert h['Memory'] == 536870912 and h['MemorySwap'] == 536870912 and h['NanoCpus'] == 1000000000 and h['PidsLimit'] == 64
            assert inspected['Config']['User'] == '65534:65534'
            assert all(not m['RW'] for m in inspected['Mounts']) and len(inspected['Mounts']) == 3
            row['isolation'] = {k: h[k] for k in ['NetworkMode', 'ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Memory', 'MemorySwap', 'NanoCpus', 'PidsLimit', 'Tmpfs']}
            row['mounts'] = inspected['Mounts']
            run = subprocess.run(['docker', 'start', '--attach', cid], capture_output=True, text=True, timeout=120)
            row.update({'startExit': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr})
            row['containerState'] = json.loads(subprocess.check_output(['docker', 'inspect', '--format={{json .State}}', cid], text=True))
        except subprocess.TimeoutExpired:
            row['timeout'] = True
            subprocess.run(['docker', 'kill', cid], capture_output=True, timeout=15)
        finally:
            deleted = subprocess.run(['docker', 'rm', '--force', cid], capture_output=True, text=True, timeout=15)
            row['containerRemoved'] = deleted.returncode == 0
    row['elapsedSeconds'] = round(time.time() - started, 3)
    reports.append(row)
    (STAGE / 'container-results-readable.json').write_text(json.dumps(reports, indent=2) + '\n')
    # Permission / network / daemon refusal stops execution, never weakens isolation.
    if created.returncode != 0 or row.get('startExit') not in (None, 0):
        break
print(json.dumps([{'side': x['side'], 'createExit': x['createExit'], 'startExit': x.get('startExit'), 'removed': x.get('containerRemoved')} for x in reports]))
