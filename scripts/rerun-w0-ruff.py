"""Finite W0 before/after retry after the recorded noexec packaging diagnosis."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import time

stage=pathlib.Path('/tmp/flyrewheel-w0-permission-attempt-1')
context=pathlib.Path('/tmp/flyrewheel-w0-full-context-attempt-1')
repo=pathlib.Path(__file__).resolve().parents[1]
diagnosis=json.loads((stage/'diagnosis.json').read_text())
observed=json.loads(diagnosis['stdout'])
assert diagnosis['exitCode']==0 and observed['ruffExecuted'] is False
assert any(line.split()[4]=='/tmp' and 'noexec' in line.split()[5].split(',') for line in observed['mounts'])
image=json.loads(subprocess.check_output(['docker','image','inspect','flyrewheel-w0-ruff-tools:local'],text=True))[0]
assert image['Config']['OnBuild'] is None
binary_metadata=json.loads((stage/'binary-metadata.json').read_text())
reports=[]
for side in ['before','after']:
    frozen=json.loads((context/f'context-3031-{side}.json').read_text())
    source=context/'exports'/('export-'+frozen['binding']['requestDigest'])/'repo'
    work=stage/('run-'+side);work.mkdir();work.chmod(0o755)
    copied=work/'source';copied.mkdir();copied.chmod(0o755)
    files=[]
    for p in sorted(source.rglob('*')):
        rel=p.relative_to(source)
        if '.git' in rel.parts:continue
        if p.is_symlink():raise RuntimeError('Unexpected symlink')
        if not p.is_file():continue
        dest=copied/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,dest);dest.chmod(0o444)
        files.append({'path':str(rel),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
    for p in copied.rglob('*'):
        if p.is_dir():p.chmod(0o755)
    harness=work/'harness';harness.mkdir();harness.chmod(0o755)
    shutil.copyfile(repo/'scripts/w0-readonly-ruff-check.py',harness/'runner.py')
    (harness/'source-manifest.json').write_text(json.dumps(files,indent=2)+'\n')
    for p in harness.iterdir():p.chmod(0o444)
    binary=next(r for r in binary_metadata if r['name']=='ruff-'+side)
    name='flyrewheel-w0-readonly-ruff-'+side
    args=['docker','create','--pull=never','--name',name,'--user','65534:65534','--network=none','--read-only','--cap-drop=ALL',
          '--security-opt=no-new-privileges:true','--pids-limit=64','--cpus=1','--memory=512m','--memory-swap=512m',
          '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777','--workdir=/source','--entrypoint=/usr/local/bin/python',
          '--mount',f'type=bind,src={copied},dst=/source,readonly','--mount',f'type=bind,src={harness},dst=/harness,readonly',
          image['Id'],'-I','/harness/runner.py',side,binary['sha256']]
    start=time.time();created=subprocess.run(args,capture_output=True,text=True,timeout=30)
    record={'side':side,'commit':frozen['sha'],'tree':frozen['tree'],'imageId':image['Id'],'imageBytes':image['Size'],
            'binary':binary,'sourceFileCount':len(files),'createArgs':args,'createExit':created.returncode,'createStderr':created.stderr}
    if created.returncode==0:
        cid=created.stdout.strip()
        try:
            info=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0];host=info['HostConfig']
            assert info['Config']['User']=='65534:65534' and host['NetworkMode']=='none' and host['ReadonlyRootfs']
            assert host['CapDrop']==['ALL'] and 'no-new-privileges:true' in host['SecurityOpt']
            assert host['Memory']==536870912 and host['NanoCpus']==1000000000 and host['PidsLimit']==64
            assert len(info['Mounts'])==2 and all(not m['RW'] for m in info['Mounts'])
            record['isolation']={k:host[k] for k in ['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','Tmpfs']}
            run=subprocess.run(['docker','start','--attach',cid],capture_output=True,text=True,timeout=120)
            record.update({'containerExit':run.returncode,'stdout':run.stdout,'stderr':run.stderr})
        except subprocess.TimeoutExpired:
            record['timeout']=True;subprocess.run(['docker','kill',cid],capture_output=True,timeout=15)
        finally:
            record['removed']=subprocess.run(['docker','rm','--force',cid],capture_output=True,timeout=15).returncode==0
    record['elapsedSeconds']=round(time.time()-start,3);reports.append(record)
    with (stage/f'result-{side}.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n')
    if record.get('containerExit')!=0:break
print(json.dumps([{'side':r['side'],'exit':r.get('containerExit'),'removed':r.get('removed')} for r in reports]))
