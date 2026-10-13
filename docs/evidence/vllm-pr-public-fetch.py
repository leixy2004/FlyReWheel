import sys,json,urllib.request,urllib.error,base64
request=json.load(sys.stdin)
assert request['url'].startswith('https://api.github.com/repos/vllm-project/vllm/')
assert not any(k.lower()=='authorization' for k in request['headers'])
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
opener=urllib.request.build_opener(NoRedirect)
req=urllib.request.Request(request['url'],headers=request['headers'],method='GET')
try: response=opener.open(req,timeout=14)
except urllib.error.HTTPError as error: response=error
with response:
 body=response.read(12000001)
 if len(body)>12000000: raise RuntimeError('Public response byte limit exceeded')
 print(json.dumps({'status':response.status,'headers':dict(response.headers),'body':base64.b64encode(body).decode()}))
