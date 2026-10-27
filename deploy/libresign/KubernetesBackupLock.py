"""Linux locks shared by scheduled/manual signing backups and Interior recovery."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat
SHARED_RECOVERY_LOCK=Path('/opt/erp-cicd/interior-readiness-20261022/private/monthly-restore.lock')
@contextmanager
def backup_lock(root):
 path=root/'backup.lock'
 with path.open('a') as lock:
  os.chmod(path,0o600)
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError('Another company backup run is already active') from None
  try:yield
  finally:fcntl.flock(lock,fcntl.LOCK_UN)
@contextmanager
def recovery_lock(path=None):
 # Reuse the exact existing inode; never replace Interior's lock or permissions.
 target=path if path is not None else SHARED_RECOVERY_LOCK
 fd=os.open(target,os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  if not stat.S_ISREG(os.fstat(fd).st_mode):raise RuntimeError('Shared recovery lock must be a regular file')
  try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError('Another database recovery batch is already active') from None
  try:yield
  finally:fcntl.flock(fd,fcntl.LOCK_UN)
 finally:os.close(fd)
@contextmanager
def backup_run_lock(root):
 with backup_lock(root), recovery_lock():yield
