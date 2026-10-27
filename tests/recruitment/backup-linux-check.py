#!/usr/bin/env python3
"""Exercise real backup coordinator lock and cancellation paths without Kubernetes."""
import importlib.util,json,os,shutil,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
TOOLS=Path(sys.argv.pop(1)) if len(sys.argv)>1 else Path(__file__).resolve().parents[2]/'deploy/libresign'
sys.path.insert(0,str(TOOLS))
from KubernetesBackupLock import backup_lock, recovery_lock
class SafetyTests(unittest.TestCase):
 def test_freshness_requires_exact_five_company_restores(self):
  spec=importlib.util.spec_from_file_location('schedule',TOOLS/'Kubernetes-BackupSchedule.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  with tempfile.TemporaryDirectory() as folder:
   module.ROOT=Path(folder);index=module.ROOT/'scheduled-test.json'
   rows={name:{'restored':{'state':'DAM_DATABASE_APPLICATION_RESTORE_PASS'}} for name in module.NAMES}
   value={'state':module.COMPLETE,'companies':rows};index.write_text(json.dumps(value));self.assertTrue(module.state()[0]['fresh'])
   os.utime(index,(time.time()-37*3600,)*2);self.assertFalse(module.state()[0]['fresh'])
   rows['unexpected']=rows.pop('joc');index.write_text(json.dumps(value));self.assertFalse(module.state()[0]['fresh'])
 def test_shared_recovery_lock_uses_existing_inode_and_refuses_overlap(self):
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'shared.lock';path.write_text('retained');before=path.stat()
   with recovery_lock(path):
    child=subprocess.run([sys.executable,'-c',"import sys;sys.path.insert(0,sys.argv[1]);from pathlib import Path;from KubernetesBackupLock import recovery_lock\nwith recovery_lock(Path(sys.argv[2])):pass",str(TOOLS),str(path)],capture_output=True,text=True)
    self.assertNotEqual(child.returncode,0);self.assertIn('already active',child.stderr)
   with recovery_lock(path):pass
   self.assertEqual(path.stat().st_ino,before.st_ino);self.assertEqual(path.read_text(),'retained')
   with self.assertRaises(FileNotFoundError):
    with recovery_lock(Path(folder)/'missing'):pass
 def test_overlapping_operator_refused(self):
  with tempfile.TemporaryDirectory() as folder:
   with backup_lock(Path(folder)):
    child=subprocess.run([sys.executable,'-c',"""import sys;sys.path.insert(0,sys.argv[1]);from pathlib import Path;from KubernetesBackupLock import backup_lock
with backup_lock(Path(sys.argv[2])):pass""",str(TOOLS),folder],capture_output=True,text=True)
    self.assertNotEqual(child.returncode,0);self.assertIn('already active',child.stderr)
   with backup_lock(Path(folder)):pass
 def test_group_stop_allows_capture_cleanup_and_prevents_retry(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder)
   for name in ['Kubernetes-BackupAll.py','KubernetesBackupLock.py','KubernetesBackupSignals.py']:shutil.copyfile(TOOLS/name,root/name)
   lock_source=(root/'KubernetesBackupLock.py').read_text().replace("SHARED_RECOVERY_LOCK=Path('/opt/erp-cicd/interior-readiness-20261022/private/monthly-restore.lock')","SHARED_RECOVERY_LOCK=Path("+repr(str(root/'shared.lock'))+")");(root/'KubernetesBackupLock.py').write_text(lock_source);(root/'shared.lock').touch()
   source=(root/'Kubernetes-BackupAll.py').read_text();source=source.replace("ROOT=Path('/opt/erp-cicd/recruitment-signing-k8s/backups')","ROOT=Path("+repr(folder)+")");(root/'Kubernetes-BackupAll.py').write_text(source)
   (root/'Kubernetes-Backup.py').write_text("import time\nfrom pathlib import Path\nfrom KubernetesBackupSignals import install_signal_handlers\ninstall_signal_handlers()\nroot=Path(__file__).parent\ntry:\n (root/'started').write_text('yes')\n time.sleep(30)\nfinally:\n time.sleep(0.2)\n (root/'cleanup').write_text('complete')\n")
   proc=subprocess.Popen([sys.executable,str(root/'Kubernetes-BackupAll.py'),'--index',str(root/'index.json')],start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    for _ in range(100):
     if (root/'started').exists():break
     if proc.poll() is not None:raise AssertionError(proc.communicate())
     time.sleep(.05)
    self.assertTrue((root/'started').exists());os.killpg(proc.pid,signal.SIGTERM);out,err=proc.communicate(timeout=10)
    self.assertNotEqual(proc.returncode,0);self.assertEqual((root/'cleanup').read_text(),'complete');self.assertNotIn('"retry"',out)
    with backup_lock(root):pass
   finally:
    if proc.poll() is None:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
if __name__=='__main__':unittest.main()
