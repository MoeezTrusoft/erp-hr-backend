"""Forward the existing collector's append-only CSVs to registered-device intake.

The destination has its own durable row checkpoints. Late rows are delivered even
when their punch time precedes an earlier row. Only a fresh, completed hardware
poll supplies a heartbeat; replaying stored punches never refreshes device health.
"""
import csv
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import time
from datetime import datetime, timezone
import urllib.request

log = logging.getLogger("attendance-public-bridge")


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name != "nt":
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def request_json(url, key, body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Intake-Key": key}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
        if not 200 <= response.status < 300 or result.get("success") is not True:
            raise RuntimeError("Attendance intake did not acknowledge storage")
        return result


def row_digest(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


def forward_file(path, checkpoint, start_date, send, save, batch_size=400):
    raw = Path(path).read_bytes()
    # The collector may currently be appending a row. Retry an incomplete tail.
    if raw and not raw.endswith(b"\n"):
        return 0
    reader = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")), strict=True)
    required = {"timestamp_device", "user_id", "punch_code", "status_code"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Collector CSV is missing required columns")
    rows = list(reader)
    done = checkpoint.get("rows", 0)
    if done > len(rows) or (done and checkpoint.get("digest") != row_digest(rows[:done])):
        raise ValueError("Previously delivered CSV rows changed; operator review required")
    sent = 0
    for offset in range(done, len(rows), batch_size):
        end = min(offset + batch_size, len(rows))
        lines = []
        for row in rows[offset:end]:
            stamp = datetime.strptime(row["timestamp_device"], "%Y-%m-%d %H:%M:%S")
            if stamp.date().isoformat() < start_date:
                continue
            uid = row["user_id"].strip()
            if not uid or any(c in uid for c in "\t\r\n"):
                raise ValueError("Invalid collector device identity")
            punch, verify = int(row["punch_code"]), int(row["status_code"])
            lines.append(f"{uid}\t{stamp:%Y-%m-%d %H:%M:%S}\t{punch}\t{verify}\t0")
        if lines:
            send(lines)  # Failure leaves this batch's checkpoint unchanged.
            sent += len(lines)
        checkpoint.update(rows=end, digest=row_digest(rows[:end]))
        save()
    return sent


def fresh_poll(info, collector_state, now, max_age=120):
    try:
        polled = datetime.fromisoformat(info["polled_at"])
        completed = datetime.fromisoformat(collector_state["last_ok"])
        return polled <= completed and 0 <= (now - completed).total_seconds() <= max_age
    except (KeyError, TypeError, ValueError):
        return False


def run_once(base, state, start_date, intake_url, key, serials, save):
    for directory in sorted((base / "data").iterdir()):
        if not directory.is_dir() or "backup" in directory.name.lower():
            continue
        try:
            info = json.loads((directory / "device.json").read_text())
            sn = info.get("serial")
            if sn not in serials:
                raise ValueError("Collector serial is not in the approved device list")
            site_state = state.setdefault("sites", {}).setdefault(directory.name, {"sn": sn, "files": {}})
            if site_state["sn"] != sn:
                raise ValueError("Collector serial changed; operator review required")
            for path in sorted(directory.glob("20*.csv")):
                if path.stem < start_date[:7]:
                    continue
                checkpoint = site_state["files"].setdefault(path.name, {})
                count = forward_file(path, checkpoint, start_date,
                    lambda rows: request_json(intake_url, key, {"sn": sn, "rows": rows}), save)
                if count:
                    log.info("site=%s sn=%s acknowledged=%d", directory.name, sn, count)
            collector = json.loads((base / "state" / (directory.name + ".json")).read_text())
            now = datetime.now(timezone.utc)
            if fresh_poll(info, collector, now) and site_state.get("heartbeat_poll") != collector["last_ok"]:
                request_json(intake_url.rsplit("/", 1)[0] + "/heartbeat", key, {"sn": sn})
                site_state["heartbeat_poll"] = collector["last_ok"]
                save()
                log.info("site=%s sn=%s fresh hardware poll acknowledged", directory.name, sn)
        except Exception as error:
            log.error("site=%s delivery held: %s", directory.name, type(error).__name__)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    base = Path(os.environ["BIO_BASE_DIR"])
    destination = os.environ["ERP_INTAKE_URL"]
    key = os.environ["ERP_INTAKE_KEY"]
    serials = set(os.environ["ERP_DEVICE_SERIALS"].split(","))
    start_date = os.environ["ERP_START_DATE"]
    datetime.strptime(start_date, "%Y-%m-%d")
    state_file = Path(os.environ["ERP_BRIDGE_STATE"])
    state = json.loads(state_file.read_text()) if state_file.exists() else {"destination": destination, "start_date": start_date, "sites": {}}
    if state.get("destination") != destination or state.get("start_date") != start_date:
        raise ValueError("Destination or effective date changed; use a reviewed new checkpoint")
    while True:
        run_once(base, state, start_date, destination, key, serials, lambda: atomic_json(state_file, state))
        time.sleep(max(5, int(os.environ.get("BRIDGE_PUSH_SECONDS", "30"))))


if __name__ == "__main__":
    main()
