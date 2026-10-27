"""Drain child cleanup when systemd stops a backup; never suppress cancellation forever."""
import signal
STOP_REQUESTED=False
class BackupInterrupted(RuntimeError):pass
def check_stop():
 if STOP_REQUESTED:raise BackupInterrupted('Backup interrupted; durable receipts can be resumed')
def install_signal_handlers(defer=False):
 def stop(signum,frame):
  global STOP_REQUESTED
  STOP_REQUESTED=True
  if not defer:check_stop()
 signal.signal(signal.SIGTERM,stop)
 signal.signal(signal.SIGINT,stop)
