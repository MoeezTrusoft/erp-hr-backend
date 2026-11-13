"""Add registered-device checks and live heartbeats to the existing ADMS receiver.

Keep its device protocol and durable intake acknowledgement behavior. This wrapper
does not contain credentials and does not synthesize attendance punches.
"""
import datetime as dt
import importlib.util
import io
import os
from http.server import ThreadingHTTPServer
import threading
import time
from urllib.parse import urlparse, parse_qs
from attendance_csv_bridge import request_json

# These devices never tell the receiver what time they think it is, but a punch pushed the moment it happens carries
# the machine's clock. One such punch is not proof (a batch re-sent after an outage looks the same), so the clock is
# only reported once two separate single-punch pushes agree about how far the machine is from this host's clock.
AGREE_SECONDS = 90
SAMPLE_MAX_AGE = 6 * 3600  # HR stops trusting a reading older than this
REQUEUE_AFTER = 600


def parse_naive(text):
    try:
        return dt.datetime.strptime(str(text).strip()[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


class ClockSampler:
    """Per machine: the last two single-punch readings as (machine wall time - this host's monotonic clock)."""

    def __init__(self, mono=time.monotonic):
        self.mono = mono
        self.samples = {}

    def punch_batch(self, sn, rows):
        if len(rows) != 1:
            return
        cols = rows[0].split("\t")
        when = parse_naive(cols[1]) if len(cols) > 1 else None
        if when:
            now = self.mono()
            self.samples.setdefault(sn, []).append((when.replace(tzinfo=dt.timezone.utc).timestamp() - now, now))
            del self.samples[sn][:-2]

    def device_time(self, sn):
        """The machine's wall-clock text now, or None when there are not two agreeing, recent readings."""
        pair = self.samples.get(sn, [])
        if len(pair) < 2 or abs(pair[0][0] - pair[1][0]) > AGREE_SECONDS:
            return None
        now = self.mono()
        if now - pair[1][1] > SAMPLE_MAX_AGE:
            return None
        return dt.datetime.fromtimestamp(pair[1][0] + now, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def queue_command(path, line):
    with open(path, "a") as handle:
        handle.write(line + "\n")


class ClockCommands:
    """HR asks a machine to set its clock; the receiver hands it over the way ADMS expects and reports the outcome."""

    def __init__(self, queue_path, template, report, mono=time.monotonic):
        self.queue_path, self.template, self.report, self.mono = queue_path, template, report, mono
        self.waiting = {}  # ADMS command number -> (HR command id, when it was queued)
        self.next_number = 9000
        self.lock = threading.Lock()

    def offered(self, sn, commands):
        for command in commands or []:
            if command.get("type") != "SET_TIME":
                continue
            with self.lock:
                queued = any(hr == command["id"] and self.mono() - at < REQUEUE_AFTER for hr, at in self.waiting.values())
                if queued:
                    continue
                if not self.template:
                    refuse = True
                else:
                    refuse = False
                    self.next_number += 1
                    self.waiting[self.next_number] = (command["id"], self.mono())
                    number = self.next_number
            if refuse:
                self.report(sn, {"id": command["id"], "ok": False, "error": "This receiver is not set up to change the machine's clock; set it on the machine"})
            else:
                queue_command(self.queue_path, "C:%d:%s" % (number, self.template.replace("{localTime}", command["localTime"])))

    def device_result(self, sn, body):
        """The machine's answer to a command: ID=<number>&Return=<0 on success>."""
        fields = {k: v[0] for k, v in parse_qs(body.replace("\n", "&").replace("\r", "")).items()}
        try:
            number = int(fields.get("ID", ""))
        except ValueError:
            return
        with self.lock:
            hit = self.waiting.pop(number, None)
        if hit:
            ok = fields.get("Return") == "0"
            self.report(sn, {"id": hit[0], "ok": ok, **({} if ok else {"error": "The machine refused the new time"})})


def wrap_handler(original, serials, heartbeat, sampler=None, commands=None):
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
                    answer = heartbeat(sn, sampler.device_time(sn) if sampler else None)
                    if commands:
                        commands.offered(sn, (answer or {}).get("commands"))
                except Exception:
                    with lock:
                        last.pop(sn, None)
                    print("Attendance heartbeat delivery pending", flush=True)
            return super().do_GET()

        def do_POST(self):
            sn = self.approved_serial()
            if not sn:
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 <= length <= 8 * 1024 * 1024:
                    raise ValueError()
            except ValueError:
                self.close_connection = True
                return self._reply(b"ERROR", code=413)
            if sampler or commands:
                body = self.rfile.read(length)
                self.rfile = io.BytesIO(body)
                parts = urlparse(self.path)
                query = parse_qs(parts.query)
                if sampler and (query.get("table") or [""])[0] == "ATTLOG":
                    sampler.punch_batch(sn, [r for r in body.decode("utf-8", "replace").splitlines() if r.strip()])
                if commands and parts.path.rstrip("/").endswith("/devicecmd"):
                    commands.device_result(sn, body.decode("utf-8", "replace"))
            return super().do_POST()

    return Handler


def main():
    spec = importlib.util.spec_from_file_location("legacy_iclock", os.environ["ICLOCK_LEGACY_SCRIPT"])
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)
    base = os.environ["HR_INGEST_URL"].rsplit("/", 1)[0]
    key = os.environ["HR_INTAKE_KEY"]
    report = lambda sn, body: request_json(base + "/command-ack", key, {"sn": sn, **body})
    # ICLOCK_SET_TIME_COMMAND is the ADMS text that sets the clock, with {localTime} for the wall-clock time to set.
    # Leave it empty until it has been proven on a real machine: HR then sees the request as failed, not silently waiting.
    commands = ClockCommands(getattr(legacy, "CMD_QUEUE", "/root/iclock_cmds.txt"), os.environ.get("ICLOCK_SET_TIME_COMMAND", ""), report)
    handler = wrap_handler(legacy.Handler, set(os.environ["ERP_DEVICE_SERIALS"].split(",")),
        lambda sn, device_time: request_json(base + "/heartbeat", key, {"sn": sn, **({"deviceTime": device_time} if device_time else {})}),
        ClockSampler(), commands)
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("ICLOCK_PORT", "8090"))), handler).serve_forever()


if __name__ == "__main__":
    main()
