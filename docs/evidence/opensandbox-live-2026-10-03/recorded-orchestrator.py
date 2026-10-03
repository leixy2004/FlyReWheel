import pathlib,json,subprocess,time,threading,queue,os,signal,shutil
root=pathlib.Path('/workspace/scratch/flyrewheel-control-prep');repo=pathlib.Path('/workspace/FlyReWheel')
a=json.loads((root/'network-admission.json').read_text());owner=a['owner'];network=a['networkName'];nid=a['networkId']
image='opensandbox/execd@sha256:9b856dad9c73460522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a'
image='opensandbox/execd@sha256:9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a'
with (root/'single-trial-admitted.json').open('x') as f:json.dump({'owner':owner,'approval':a['approvalReference']},f)
r={'owner':owner,'networkId':nid,'network':network,'approval':a['approvalReference'],'status':'failed','cleanup':{},'events':[]};start=time.monotonic();minimum=shutil.disk_usage('/workspace').free
control=driver=events=task=None;q=queue.Queue();helpers=set();workers=set();errors=[]
def docker(args):return subprocess.check_output(['docker',*args],text=True,timeout=20,stderr=subprocess.DEVNULL)
def watch_events():
 try:
  for line in events.stdout:
   if len(line)>65536:raise RuntimeError('event bound')
   e=json.loads(line);actor=e.get('Actor',{});attrs=actor.get('Attributes',{});identity=actor.get('ID')
   if attrs.get('flyrewheel.lifecycle-owner')==owner:workers.add(identity)
   if attrs.get('name','').startswith('sandbox-execd-') and attrs.get('image')==image:helpers.add(identity)
   if identity in helpers or identity in workers:
    r['events'].append({'id':identity,'action':e.get('Action'),'helper':identity in helpers})
    if len(r['events'])>256:raise RuntimeError('event count bound')
 except Exception as e:errors.append(type(e).__name__)
def watch_control():
 for line in control.stdout:
  if len(line)>65536:q.put({'status':'output-bound'});return
  try:q.put(json.loads(line))
  except:q.put({'status':'non-json-output'})
def cleanup():
 removed=[]
 for _ in range(3):
  workers.update(docker(['ps','-aq','--filter','label=flyrewheel.lifecycle-owner='+owner]).split());allids=set(docker(['ps','-aq']).split())
  for identity in list(workers|helpers):
   if identity not in allids:continue
   o=json.loads(docker(['inspect',identity]))[0]
   ours=o['Config']['Labels'].get('flyrewheel.lifecycle-owner')==owner
   helper=identity in helpers and o['Config']['Image']==image and o['HostConfig']['NetworkMode']=='none' and o['State']['StartedAt'].startswith('0001-')
   if not(ours or helper):raise RuntimeError('ownership mismatch')
   docker(['rm','-f',identity]);removed.append(identity)
  time.sleep(.5)
 left=set(docker(['ps','-aq']).split())&(workers|helpers);r['cleanup'].update(removedContainers=removed,ownedContainersAbsent=not left)
 if left:raise RuntimeError('containers remain')
try:
 net=json.loads(docker(['network','inspect',nid]))[0];assert net['Internal'] and net['Labels']['flyrewheel.lifecycle-owner']==owner and not net['Containers'];assert not docker(['ps','-aq']).strip()
 events=subprocess.Popen(['docker','events','--filter','type=container','--format','{{json .}}'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True);threading.Thread(target=watch_events,daemon=True).start()
 args=['python3','-B',str(repo/'scripts/opensandbox-control-plane.py'),'--execute','--approval-ref',a['approvalReference'],'--source',str(root/'source'),'--python',str(root/'venv/bin/python'),'--execd-image',image,'--dedicated-daemon','--network',network,'--network-owner',owner]
 control=subprocess.Popen(args,cwd=repo,env={'PATH':os.environ['PATH'],'PYTHONDONTWRITEBYTECODE':'1'},stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True);threading.Thread(target=watch_control,daemon=True).start()
 until=time.monotonic()+45
 while time.monotonic()<until:
  if control.poll() is not None:raise RuntimeError('control plane exited before readiness')
  try:m=q.get(timeout=.25)
  except queue.Empty:continue
  r.setdefault('controlEvents',[]).append(m)
  if m.get('status')=='process-started-readiness-unverified':task=pathlib.Path(m['task']);break
 else:raise RuntimeError('control startup deadline')
 driver=subprocess.Popen(['node','--import','tsx',str(repo/'scripts/run-opensandbox-local-smoke.ts'),str(task),owner,network,str(root/'lifecycle-result.json')],cwd=repo,env={'PATH':os.environ['PATH'],'OPENSANDBOX_DISABLE_METRICS':'1'},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
 while driver.poll() is None:
  minimum=min(minimum,shutil.disk_usage('/workspace').free)
  if time.monotonic()-start>180 or minimum<6*1024**3:raise RuntimeError('trial deadline or disk guard')
  time.sleep(.25)
 r['driverExitCode']=driver.returncode
 if (root/'lifecycle-result.json').exists():r['lifecycle']=json.loads((root/'lifecycle-result.json').read_text())
 r['status']='succeeded' if driver.returncode==0 else 'failed'
except Exception as e:r['error']=str(e)
finally:
 if driver and driver.poll() is None:os.killpg(driver.pid,signal.SIGKILL);driver.wait(timeout=5)
 try:cleanup()
 except Exception as e:r['cleanup']['containerError']=str(e)
 if control:
  if control.poll() is None:os.killpg(control.pid,signal.SIGTERM)
  try:control.wait(timeout=15)
  except subprocess.TimeoutExpired:r['cleanup']['controlTimeout']=True
  time.sleep(.5)
  while not q.empty():r.setdefault('controlEvents',[]).append(q.get())
 r['cleanup']['taskSecretsAbsent']=task is None or not task.exists()
 try:
  net=json.loads(docker(['network','inspect',nid]))[0];assert net['Labels']['flyrewheel.lifecycle-owner']==owner and not net['Containers'];docker(['network','rm',nid]);r['cleanup']['networkAbsent']=nid not in docker(['network','ls','--no-trunc','-q']).split()
 except Exception as e:r['cleanup']['networkError']=str(e)
 try:docker(['image','rm',image]);r['cleanup']['newExecdImageRemoved']=True
 except Exception as e:r['cleanup']['imageError']=type(e).__name__
 if events:events.terminate();events.wait(timeout=5)
 r.update(helperIds=sorted(helpers),workerIds=sorted(workers),eventErrors=errors,helperStarted=any(e['helper'] and e['action']=='start' for e in r['events']),minimumObservedFreeBytes=minimum,elapsedSeconds=round(time.monotonic()-start,3))
 (root/'trial-receipt.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
