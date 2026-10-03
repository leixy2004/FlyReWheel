"""Bounded, no-start Docker archive check for one immutable public image."""
import hashlib, io, json, pathlib, selectors, shutil, subprocess, sys, tarfile, time, uuid
IMAGE='opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a'
if sys.argv[1:] != ['--execute']:
 print(json.dumps({'mode':'dry-run','image':IMAGE,'actions':['bounded pull if absent','create never-started restricted helper','archive fixed paths','remove owned helper and new image']}))
 raise SystemExit(0 if not sys.argv[1:] else 2)
LABEL='flyrewheel.execd-archive-check'; owned=str(uuid.uuid4()); name='flyrewheel-execd-archive-'+owned
started=time.monotonic(); minimum=shutil.disk_usage('/workspace').free; rows=[]; removed=False; image_removed=False
receipt={'ownership':owned,'name':name,'image':IMAGE,'status':'failed','archives':rows}
def run(args,timeout=30,cap=2*1024**2,guard=True):
 global minimum
 p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,0);sel.register(p.stderr,selectors.EVENT_READ,1);buf=[bytearray(),bytearray()];end=time.monotonic()+timeout
 try:
  while sel.get_map():
   minimum=min(minimum,shutil.disk_usage('/workspace').free)
   if time.monotonic()>end or (guard and (time.monotonic()-started>180 or minimum<6*1024**3)): raise RuntimeError('deadline or disk reserve')
   for key,_ in sel.select(.25):
    chunk=key.fileobj.read1(65536)
    if not chunk: sel.unregister(key.fileobj);continue
    buf[key.data].extend(chunk)
    if len(buf[0])+len(buf[1])>cap: raise RuntimeError('output bound')
  code=p.wait(timeout=2)
  if code: raise RuntimeError('command failed: '+args[0]+' '+args[1]+' exit '+str(code))
  return bytes(buf[0])
 finally:
  if p.poll() is None: p.kill();p.wait(timeout=5)
  sel.close();p.stdout.close();p.stderr.close()
def inspect():
 obj=json.loads(run(['docker','inspect',name]))[0]
 assert obj['Config']['Labels'].get(LABEL)==owned
 return obj
def state(obj):
 s=obj['State'];h=obj['HostConfig']
 assert s['Status']=='created' and s['Pid']==0 and s['StartedAt'].startswith('0001-') and not s['Running']
 assert h['NetworkMode']=='none' and h['CapDrop']==['ALL'] and 'no-new-privileges' in h['SecurityOpt'] and h['ReadonlyRootfs']
 assert not h['Privileged'] and not h['PortBindings'] and not obj['Mounts']
 return {k:s[k] for k in ['Status','Pid','StartedAt','Running']}
preexisting=subprocess.run(['docker','image','inspect',IMAGE],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
try:
 if not preexisting: run(['docker','pull','--platform','linux/amd64',IMAGE],timeout=90)
 run(['docker','create','--name',name,'--label',LABEL+'='+owned,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--pids-limit','16','--memory','128m','--cpus','0.5',IMAGE],timeout=45)
 obj=inspect();receipt['containerId']=obj['Id'];receipt['before']=state(obj)
 for path in ['/execd','/bootstrap.sh','/usr/local/bin/bwrap','/usr/local/libexec/opensandbox-session-gate','/usr/local/libexec/opensandbox-launcher']:
  archive=run(['docker','cp',name+':'+path,'-'],timeout=20,cap=64*1024**2)
  with tarfile.open(fileobj=io.BytesIO(archive),mode='r:') as tar:
   members=tar.getmembers();assert len(members)==1 and members[0].isfile()
   m=members[0];f=tar.extractfile(m);digest=hashlib.file_digest(f,'sha256').hexdigest()
   rows.append({'path':path,'archiveBytes':len(archive),'fileBytes':m.size,'mode':oct(m.mode),'sha256':digest})
 receipt['after']=state(inspect())
 try: run(['docker','cp',name+':/flyrewheel-intentionally-missing-asset','-'],timeout=10)
 except RuntimeError: receipt['missingPathRejected']=True
 else: raise RuntimeError('missing path unexpectedly succeeded')
 receipt['status']='archive-succeeded-never-started'
except Exception as e: receipt['error']=str(e)
finally:
 try:
  obj=inspect();run(['docker','rm',obj['Id']],guard=False,timeout=20)
  removed=subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
 except Exception: removed=subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
 if not preexisting:
  try: run(['docker','image','rm',IMAGE],guard=False,timeout=30);image_removed=True
  except Exception: pass
 receipt.update({'containerRemoved':removed,'newImageRemoved':image_removed,'imageWasPreexisting':preexisting,'minimumObservedFreeBytes':minimum,'elapsedSeconds':round(time.monotonic()-started,3)})
 pathlib.Path('/tmp/flyrewheel-stopped-execd-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 print(json.dumps(receipt,indent=2))
 if not removed or receipt['status']!='archive-succeeded-never-started': raise SystemExit(1)
