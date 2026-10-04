import importlib.util,json,pathlib,unittest
p=pathlib.Path(__file__).resolve().parents[1]/'scripts/verify-stopped-execd.py'
spec=importlib.util.spec_from_file_location('stopped',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Checks(unittest.TestCase):
 def failure(self,message):
  def run(args,**kw): raise m.DockerFailure(args,1,message.encode())
  return run
 def test_inspect_daemon_error_never_absent(self):
  with self.assertRaises(m.DockerFailure):m.lookup(self.failure('Cannot connect to daemon'),'container','x')
  with self.assertRaises(m.DockerFailure):m.lookup(self.failure('permission denied'),'image','x')
 def test_exact_not_found_only(self):
  self.assertIsNone(m.lookup(self.failure('Error: No such object: x'),'container','x'))
  with self.assertRaises(m.DockerFailure):m.lookup(self.failure('Error: No such object: y'),'container','x')
 def test_missing_path_requires_specific_daemon_error(self):
  self.assertTrue(m.missing_path(self.failure('Error response from daemon: Could not find the file /absent in container x'),'x','/absent'))
  with self.assertRaises(m.DockerFailure):m.missing_path(self.failure('daemon unavailable'),'x','/absent')
  def timeout(*a,**k):raise RuntimeError('deadline')
  with self.assertRaises(RuntimeError):m.missing_path(timeout,'x','/absent')
 def test_cleanup_independent_guard_and_image_failure(self):
  calls=[]
  def run(args,**kw):
   calls.append((args,kw));self.assertFalse(kw['guard']);self.assertLessEqual(kw['timeout'],30)
   if args==['docker','inspect','x']:
    if len(calls)==1:return json.dumps([{'Id':'id','Config':{'Labels':{m.LABEL:'owner'}}}]).encode()
    raise m.DockerFailure(args,1,b'Error: No such object: x')
   if args==['docker','image','inspect',m.IMAGE]:return b'[{"Id":"image"}]'
   if args[1:3]==['image','rm']:raise m.DockerFailure(args,1,b'image in use')
   return b''
  result=m.cleanup(run,'x','owner',True)
  self.assertTrue(result['containerRemoved']);self.assertFalse(result['newImageRemoved']);self.assertTrue(result['cleanupErrors'])
 def test_wrong_owner_not_removed(self):
  calls=[]
  def run(args,**kw):calls.append(args);return json.dumps([{'Id':'id','Config':{'Labels':{m.LABEL:'other'}}}]).encode()
  result=m.cleanup(run,'x','owner',False)
  self.assertFalse(result['containerRemoved']);self.assertEqual(len(calls),1)
if __name__=='__main__':unittest.main()
