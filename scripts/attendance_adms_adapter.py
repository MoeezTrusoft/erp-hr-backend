"""Add registered-device checks and live heartbeats to the existing ADMS receiver.

Keep its device protocol and durable intake acknowledgement behavior. This wrapper
does not contain credentials and does not synthesize attendance punches.
"""
import importlib.util
import os
from http.server import ThreadingHTTPServer
import threading
import time
from urllib.parse import urlparse, parse_qs
from attendance_csv_bridge import request_json


def wrap_handler(original, serials, heartbeat):
    lock = threading.Lock()
    last = {}

    class Handler(original):
        timeout = 30

        def approved_serial(self):
            sn = (parse_qs(urlparse(self.path).query).get("SN") or [""])[0]
            if sn not in serials:
                self.close_connection = True
                self._reply(b"ERROR", code=403)
                return None
            return sn

        def do_GET(self):
            sn = self.approved_serial()
            if not sn:
                return
            with lock:
                due = time.monotonic() - last.get(sn, float("-inf")) >= 30
                if due:
                    last[sn] = time.monotonic()
            if due:
                try:
                    heartbeat(sn)
                except Exception:
                    with lock:
                        last.pop(sn, None)
                    print("Attendance heartbeat delivery pending", flush=True)
            return super().do_GET()

        def do_POST(self):
            if not self.approved_serial():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 <= length <= 8 * 1024 * 1024:
                    raise ValueError()
            except ValueError:
                self.close_connection = True
                return self._reply(b"ERROR", code=413)
            return super().do_POST()

    return Handler


def main():
    spec = importlib.util.spec_from_file_location("legacy_iclock", os.environ["ICLOCK_LEGACY_SCRIPT"])
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    url = os.environ["HR_INGEST_URL"].rsplit("/", 1)[0] + "/heartbeat"
    key = os.environ["HR_INTAKE_KEY"]
    handler = wrap_handler(legacy.Handler, set(os.environ["ERP_DEVICE_SERIALS"].split(",")),
        lambda sn: request_json(url, key, {"sn": sn}))
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("ICLOCK_PORT", "8090"))), handler).serve_forever()


if __name__ == "__main__":
    main()
