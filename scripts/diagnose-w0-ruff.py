"""One metadata-only container; never executes Ruff or upstream source."""
import json
import pathlib
import subprocess

STAGE = pathlib.Path('/tmp/flyrewheel-w0-permission-attempt-1')
IMAGE = 'sha256:d3846bce6e97d0ef5c32fc023300d5e39251ad791e6fdfaee41d2ba75246766e'
CODE = r'''
import hashlib,json,os,pathlib,subprocess,sys
cmd=[sys.executable,'-m','pip','--isolated','install','--disable-pip-version-check','--no-cache-dir','--no-index','--no-deps','--only-binary=:all:','--require-hashes','--find-links=/wheels','--target=/tmp/deps','-r','/wheels/requirements.lock']
r=subprocess.run(cmd,capture_output=True,text=True,timeout=60)
result={'uid':os.getuid(),'install':{'command':cmd,'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr},'ruffExecuted':False}
result['mounts']=[line for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4] in ['/tmp','/wheels','/']]
for p in ['/tmp/deps','/tmp/deps/bin','/tmp/deps/bin/ruff','/lib64/ld-linux-x86-64.so.2']:
 try:
  s=os.stat(p);v={'path':p,'mode':oct(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'executableAccess':os.access(p,os.X_OK)}
  if p.endswith('/ruff'):v['sha256']=hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
  result.setdefault('paths',[]).append(v)
 except OSError as e:result.setdefault('paths',[]).append({'path':p,'errno':e.errno})
print(json.dumps(result,indent=2))
'''
args=['docker','create','--pull=never','--name','flyrewheel-w0-ruff-diagnosis','--user','65534:65534','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pids-limit=64','--cpus=1','--memory=512m','--memory-swap=512m','--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777','--mount','type=bind,src=/tmp/flyrewheel-w0-behavior-attempt-1/ruff-before,dst=/wheels,readonly','--entrypoint=/usr/local/bin/python',IMAGE,'-I','-c',CODE]
created=subprocess.run(args,capture_output=True,text=True,timeout=30)
record={'createArgs':args,'createExit':created.returncode,'createStderr':created.stderr}
if created.returncode==0:
 cid=created.stdout.strip()
 try:
  state=json.loads(subprocess.check_output(['docker','inspect',cid],text=True))[0]
  record['hostConfig']={k:state['HostConfig'][k] for k in ['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','Memory','MemorySwap','NanoCpus','PidsLimit','Tmpfs']}
  r=subprocess.run(['docker','start','--attach',cid],capture_output=True,text=True,timeout=120)
  record.update({'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
 except subprocess.TimeoutExpired:
  record['timeout']=True;subprocess.run(['docker','kill',cid],capture_output=True,timeout=15)
 finally:
  record['removed']=subprocess.run(['docker','rm','--force',cid],capture_output=True,timeout=15).returncode==0
with (STAGE/'diagnosis.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n')
print(json.dumps(record,indent=2))
