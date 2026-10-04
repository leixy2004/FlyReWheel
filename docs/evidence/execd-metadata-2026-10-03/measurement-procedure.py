import urllib.request, urllib.parse, json, hashlib, pathlib, tempfile, signal, time, gzip, tarfile, shutil
ROOT=pathlib.Path('/tmp/flyrewheel-execd-metadata')
CAP_C=80*1024**2; CAP_U=256*1024**2
started=time.monotonic(); total_c=0; total_u=0; rows=[]
class Bound(Exception): pass
def alarm(*_): raise Bound('120-second total deadline')
signal.signal(signal.SIGALRM,alarm); signal.alarm(120)
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  if urllib.parse.urlparse(newurl).scheme!='https': raise Bound('non-HTTPS redirect rejected')
  new=super().redirect_request(req,fp,code,msg,headers,newurl)
  if urllib.parse.urlparse(req.full_url).netloc!=urllib.parse.urlparse(newurl).netloc:
   new.remove_header('Authorization')
  return new
opener=urllib.request.build_opener(Redirect())
def request(url,token=None):
 return opener.open(urllib.request.Request(url,headers={'Authorization':'Bearer '+token} if token else {}),timeout=15)
manifest=json.loads((ROOT/'manifest.json').read_bytes()); config=json.loads((ROOT/'config.json').read_bytes())
assert hashlib.sha256((ROOT/'manifest.json').read_bytes()).hexdigest()=='9b856dad9c73488660522361abfaaa1ddbb9032169bcfb44c83348f46bc1cd9a'
assert 'sha256:'+hashlib.sha256((ROOT/'config.json').read_bytes()).hexdigest()==manifest['config']['digest']
assert sum(x['size'] for x in manifest['layers'])<=CAP_C
cache=pathlib.Path(tempfile.mkdtemp(prefix='flyrewheel-execd-layer-',dir='/tmp')); status='not-admitted'; reason=None
try:
 with request('https://auth.docker.io/token?service=registry.docker.io&scope=repository:opensandbox/execd:pull') as r:
  b=r.read(65537)
  if len(b)>65536: raise Bound('anonymous registry response bound')
  token=json.loads(b)['token']
 for i,layer in enumerate(manifest['layers']):
  assert layer['mediaType']=='application/vnd.oci.image.layer.v1.tar+gzip'
  path=cache/'layer.gz'; ch=hashlib.sha256(); c=0
  with request('https://registry-1.docker.io/v2/opensandbox/execd/blobs/'+layer['digest'],token) as r, path.open('xb') as f:
   while True:
    chunk=r.read(min(65536,CAP_C-total_c+1))
    if not chunk: break
    c+=len(chunk);total_c+=len(chunk)
    if c>layer['size'] or total_c>CAP_C: raise Bound('compressed byte bound')
    ch.update(chunk);f.write(chunk)
  if c!=layer['size'] or 'sha256:'+ch.hexdigest()!=layer['digest']: raise Bound('compressed length/digest mismatch')
  uh=hashlib.sha256(); u=0; entries=0; logical=0; rounded=0; whiteouts=0; links=0; directories=0
  class Reader:
   def __init__(self,f): self.f=f
   def read(self,n=-1):
    global total_u,u
    if n<0 or n>65536: n=65536
    data=self.f.read(min(n,CAP_U-total_u+1));total_u+=len(data);u+=len(data)
    if total_u>CAP_U: raise Bound('expanded 256 MiB aggregate bound')
    uh.update(data);return data
  with gzip.open(path,'rb') as gz:
   stream=Reader(gz)
   with tarfile.open(fileobj=stream,mode='r|',bufsize=10240) as tar:
    for member in tar:
     entries+=1
     if entries>100000: raise Bound('entry count bound')
     if member.issparse() or any('sparse' in k.lower() for k in member.pax_headers): raise Bound('sparse semantics unsupported')
     if not (member.isfile() or member.isdir() or member.issym() or member.islnk() or member.ischr() or member.isblk() or member.isfifo()): raise Bound('unsupported member type')
     logical+=member.size
     if logical>CAP_U: raise Bound('member logical size bound')
     rounded+=((member.size+4095)//4096)*4096+4096
     whiteouts+=int(pathlib.PurePosixPath(member.name).name.startswith('.wh.'))
     links+=int(member.issym() or member.islnk());directories+=int(member.isdir())
   while stream.read(65536): pass
  if 'sha256:'+uh.hexdigest()!=config['rootfs']['diff_ids'][i]: raise Bound('expanded diff ID mismatch')
  rows.append({'index':i,'digest':layer['digest'],'compressedBytes':c,'expandedTarBytes':u,'memberLogicalBytes':logical,'memberRoundedPlusMetadataEstimate':rounded,'entries':entries,'whiteouts':whiteouts,'links':links,'directories':directories,'verifiedDiffId':config['rootfs']['diff_ids'][i]})
  path.unlink()
  print(json.dumps({'completedLayer':i,'compressedBytesTotal':total_c,'expandedBytesTotal':total_u}),flush=True)
 status='measurement-complete-not-runtime-admission'
except BaseException as e:
 reason=str(e) if isinstance(e,Bound) else type(e).__name__
finally:
 signal.alarm(0);shutil.rmtree(cache)
 result={'status':status,'reason':reason,'elapsedSeconds':round(time.monotonic()-started,3),'compressedBytesRead':total_c,'expandedTarBytesRead':total_u,'compressedCapBytes':CAP_C,'expandedCapBytes':CAP_U,'layers':rows,'cacheRemoved':not cache.exists(),'noExtractionOrDockerImport':True}
 (ROOT/'measurement.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({k:v for k,v in result.items() if k!='layers'}),flush=True)
