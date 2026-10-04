import importlib.util,json,pathlib,subprocess,time,uuid,sys
from types import SimpleNamespace
repo=pathlib.Path('/workspace/FlyReWheel');state=pathlib.Path('/workspace/scratch/flyrewheel-authorized-retry-2026-10-04')
if state.exists():raise SystemExit('Persistent trial directory exists: refuse a new admission')
spec=importlib.util.spec_from_file_location('control',repo/'scripts/opensandbox-control-plane.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
owner=str(uuid.uuid4());network='flyrewheel-internal-'+owner
approval='Sentinel_6a7d932d8530819183b1701ec77f5b71 2026-10-04 08:06 UTC explicit additional one-allocation approval'
node='/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node'
options=SimpleNamespace(trial_state=str(state),network_owner=owner,network=network,approval_ref=approval,expires_unix_ms=int(time.time()*1000)+180000)
m.disk_guard(['/workspace','/tmp'],preparation=True)
assert not m.public_command(['docker','ps','-aq']).strip()
m.trial_admission(options)
network_id=None
try:
 network_id=m.public_command(['docker','network','create','--driver','bridge','--internal','--label','flyrewheel.lifecycle-owner='+owner,'--opt','com.docker.network.bridge.host_binding_ipv4=127.0.0.1',network]).strip()
 m.exclusive_json(state/'preparation.json',{'networkId':network_id,'sourceCommit':'c7985bcd45b90e6f9e17fb0dd7704af65b7ad440','execdIntroduced':True,'nodeVersion':'v24.19.0'})
 print(json.dumps({'state':str(state),'owner':owner,'network':network,'networkId':network_id,'deadlineUnixMs':options.expires_unix_ms}),flush=True)
 args=[sys.executable,'-B',str(repo/'scripts/opensandbox-control-plane.py'),'--execute','--trial-state',str(state),'--node-executable',node,'--expires-unix-ms',str(options.expires_unix_ms),'--approval-ref',approval,'--source','/workspace/scratch/flyrewheel-control-prep/source','--python','/workspace/scratch/flyrewheel-control-prep/venv/bin/python','--execd-image',m.EXECD_IMAGE,'--dedicated-daemon','--network',network,'--network-owner',owner]
 result=subprocess.run(args,cwd=repo,timeout=300)
 print(json.dumps({'outerExitCode':result.returncode,'state':str(state)}),flush=True)
finally:
 # The tested trial owns live cleanup. This guard handles only an unused network
 # if preparation/startup failed before that ownership was established.
 if network_id and network_id in m.public_command(['docker','network','ls','--no-trunc','-q']).split():
  net=json.loads(m.public_command(['docker','network','inspect',network_id]))[0]
  if net.get('Labels',{}).get('flyrewheel.lifecycle-owner')==owner and not net.get('Containers'):
   m.public_command(['docker','network','rm',network_id])
