"""Default dry-run; explicit bounded no-start archive check of one pinned image."""
import hashlib, io, json, pathlib, selectors, shutil, subprocess, sys, tarfile, time, uuid
IMAGE='opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a'
LABEL='flyrewheel.execd-archive-check'
PATHS=['/execd','/bootstrap.sh','/usr/local/bin/bwrap','/usr/local/libexec/opensandbox-session-gate','/usr/local/libexec/opensandbox-launcher']
class DockerFailure(RuntimeError):
 def __init__(self,args,code,stderr):
  super().__init__('docker '+args[1]+' exit '+str(code));self.stderr=stderr.decode(errors='replace').strip()
class Runner:
 def __init__(self): self.started=time.monotonic();self.minimum=shutil.disk_usage('/workspace').free
 def __call__(self,args,timeout=30,cap=2*1024**2,guard=True):
  p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,0);sel.register(p.stderr,selectors.EVENT_READ,1);buf=[bytearray(),bytearray()];end=time.monotonic()+timeout
  try:
   while sel.get_map():
    self.minimum=min(self.minimum,shutil.disk_usage('/workspace').free)
    if time.monotonic()>end or (guard and (time.monotonic()-self.started>180 or self.minimum<6*1024**3)): raise RuntimeError('deadline or disk reserve')
    for key,_ in sel.select(.25):
     chunk=key.fileobj.read1(65536)
     if not chunk: sel.unregister(key.fileobj);continue
     buf[key.data].extend(chunk)
     if len(buf[0])+len(buf[1])>cap: raise RuntimeError('output bound')
   code=p.wait(timeout=2)
   if code: raise DockerFailure(args,code,bytes(buf[1]))
   return bytes(buf[0])
  finally:
   if p.poll() is None: p.kill();p.wait(timeout=5)
   sel.close();p.stdout.close();p.stderr.close()
def lookup(run,kind,ref,guard=True):
 args=['docker']+(['image'] if kind=='image' else [])+['inspect',ref]
 try:
  result=json.loads(run(args,guard=guard,timeout=10));assert len(result)==1
  return result[0]
 except DockerFailure as e:
  expected=('Error response from daemon: No such image: ' if kind=='image' else 'Error: No such object: ')+ref
  if e.stderr==expected: return None
  raise
def owned_object(run,name,owner,guard=True):
 obj=lookup(run,'container',name,guard)
 if obj is not None and obj['Config']['Labels'].get(LABEL)!=owner: raise RuntimeError('ownership mismatch')
 return obj
def state(obj):
 s=obj['State'];h=obj['HostConfig']
 assert s['Status']=='created' and s['Pid']==0 and s['StartedAt'].startswith('0001-') and not s['Running']
 assert h['NetworkMode']=='none' and h['CapDrop']==['ALL'] and 'no-new-privileges' in h['SecurityOpt'] and h['ReadonlyRootfs']
 assert not h['Privileged'] and not h['PortBindings'] and not obj['Mounts']
 return {k:s[k] for k in ['Status','Pid','StartedAt','Running']}
def missing_path(run,name,path):
 try: run(['docker','cp',name+':'+path,'-'],timeout=10)
 except DockerFailure as e:
  expected='Error response from daemon: Could not find the file '+path+' in container '+name
  if e.stderr==expected: return True
  raise
 raise RuntimeError('missing path unexpectedly succeeded')
def cleanup(run,name,owner,remove_image):
 # Separate bounded command timeouts, not the expired operation/disk guard.
 result={'containerRemoved':False,'newImageRemoved':False,'cleanupErrors':[]}
 try:
  obj=owned_object(run,name,owner,guard=False)
  if obj: run(['docker','rm',obj['Id']],guard=False,timeout=20)
  result['containerRemoved']=lookup(run,'container',name,guard=False) is None
 except Exception as e: result['cleanupErrors'].append(type(e).__name__+': '+str(e))
 if remove_image:
  try:
   if lookup(run,'image',IMAGE,guard=False): run(['docker','image','rm',IMAGE],guard=False,timeout=30)
   result['newImageRemoved']=lookup(run,'image',IMAGE,guard=False) is None
  except Exception as e: result['cleanupErrors'].append(type(e).__name__+': '+str(e))
 return result

def main(args):
 if args!=['--execute']:
  print(json.dumps({'mode':'dry-run','image':IMAGE,'actions':['bounded pull if absent','create never-started restricted helper','archive fixed paths','remove owned helper and new image']}));return 0 if not args else 2
 run=Runner();owner=str(uuid.uuid4());name='flyrewheel-execd-archive-'+owner
 receipt={'ownership':owner,'name':name,'image':IMAGE,'status':'failed','archives':[]};preexisting=None;create_attempted=False
 try:
  preexisting=lookup(run,'image',IMAGE) is not None
  if not preexisting: run(['docker','pull','--platform','linux/amd64',IMAGE],timeout=90)
  create_attempted=True
  run(['docker','create','--name',name,'--label',LABEL+'='+owner,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','16','--memory','128m','--cpus','0.5',IMAGE],timeout=45)
  obj=owned_object(run,name,owner);receipt['containerId']=obj['Id'];receipt['before']=state(obj)
  total=0
  for path in PATHS:
   archive=run(['docker','cp',name+':'+path,'-'],timeout=20,cap=64*1024**2);total+=len(archive)
   if total>128*1024**2: raise RuntimeError('aggregate archive bound')
   with tarfile.open(fileobj=io.BytesIO(archive),mode='r:') as tar:
    members=tar.getmembers();assert len(members)==1 and members[0].isfile()
    m=members[0];f=tar.extractfile(m);digest=hashlib.file_digest(f,'sha256').hexdigest()
    receipt['archives'].append({'path':path,'archiveBytes':len(archive),'fileBytes':m.size,'mode':oct(m.mode),'sha256':digest})
  receipt['after']=state(owned_object(run,name,owner))
  receipt['missingPathRejected']=missing_path(run,name,'/flyrewheel-intentionally-missing-asset')
  receipt['status']='archive-succeeded-never-started'
 except Exception as e: receipt['error']=str(e)
 finally:
  result=cleanup(run,name,owner,preexisting is False) if create_attempted or preexisting is False else {'containerRemoved':False,'newImageRemoved':False,'cleanupErrors':['preflight failed; no resource creation attempted']}
  receipt.update(result)
  if not result['containerRemoved'] or result['cleanupErrors'] or (preexisting is False and not result['newImageRemoved']): receipt['status']='cleanup-unverified'
  receipt.update({'imageWasPreexisting':preexisting,'minimumObservedFreeBytes':run.minimum,'elapsedSeconds':round(time.monotonic()-run.started,3),'lateAllocationGuarantee':False})
  pathlib.Path('/tmp/flyrewheel-stopped-execd-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
 return 0 if receipt['status']=='archive-succeeded-never-started' else 1
if __name__=='__main__': raise SystemExit(main(sys.argv[1:]))
