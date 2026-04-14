#!/usr/bin/env python3
"""
ZKTeco K20 – 24/7 Live Attendance Listener
==========================================
Spawned as a subprocess by attendance.listener.service.js.
All communication is via stdout (line-delimited JSON).

JSON protocol
─────────────
Status:
  {"type":"listener_status","state":"connected"|"error"|"warning","message":"..."}

Bootstrap (on connect, dumps ALL existing device records):
  {"type":"bootstrap","events":[{device_user_id, uid, timestamp, punch, status, user_name}, ...]}

Real-time punch (no "type" key — handled as a raw event):
  {device_user_id, uid, timestamp, punch, status, user_name}
"""
from __future__ import annotations

import argparse
import json
import sys
import time


# ── stdout helpers ────────────────────────────────────────────────────────────
def _emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


# ── safe import ───────────────────────────────────────────────────────────────
try:
    from zk import ZK
    from zk.exception import ZKNetworkError, ZKErrorResponse
except ImportError:
    _emit({"type": "listener_status", "state": "error",
           "message": "pyzk not installed – run: pip install pyzk"})
    sys.exit(1)


def _status(state: str, message: str = "") -> None:
    _emit({"type": "listener_status", "state": state, "message": message})


# ── build ZK packet ───────────────────────────────────────────────────────────
def _make_zk(host: str, port: int, password: int, timeout: int, udp: bool) -> ZK:
    return ZK(host, port=port, timeout=timeout, password=password,
               force_udp=udp, ommit_ping=True)


# ── serialise a raw ZK attendance/log record ─────────────────────────────────
def _serialise(log, users_by_id: dict, users_by_uid: dict) -> dict | None:
    ts = getattr(log, "timestamp", None)
    if not ts:
        return None
    device_user_id = str(getattr(log, "user_id", "")).strip()
    uid            = str(getattr(log, "uid",     "")).strip()
    punch          = getattr(log, "punch",  0)
    status         = getattr(log, "status", 0)

    user      = users_by_id.get(device_user_id) or users_by_uid.get(uid)
    user_name = getattr(user, "name", "") if user else ""

    return {
        "device_user_id": device_user_id,
        "uid":            uid,
        "timestamp":      ts.isoformat(),
        "punch":          punch,
        "status":         status,
        "user_name":      user_name,
    }


# ── one connection cycle ──────────────────────────────────────────────────────
def _run_once(host: str, port: int, password: int, timeout: int) -> None:
    """
    Connect, dump bootstrap, then live-capture.
    Raises on any failure so the outer loop can reconnect.
    """
    # Try TCP first, then UDP
    conn = None
    for udp in (False, True):
        try:
            zk   = _make_zk(host, port, password, timeout, udp)
            conn = zk.connect()
            break
        except Exception as e:
            if udp:
                raise   # both protocols failed
            _status("warning", f"TCP failed ({e}), trying UDP")

    _status("connected", f"Connected to {host}:{port}")

    try:
        conn.disable_device()

        # ── bootstrap: dump all existing records ──────────────────────────
        users = conn.get_users() or []
        logs  = conn.get_attendance() or []

        users_by_id  = {str(getattr(u, "user_id", "")).strip(): u for u in users}
        users_by_uid = {str(getattr(u, "uid",     "")).strip(): u for u in users}

        events = []
        for log in logs:
            record = _serialise(log, users_by_id, users_by_uid)
            if record:
                events.append(record)

        _emit({"type": "bootstrap", "events": events})

        conn.enable_device()

        # ── live capture: stream new punches ──────────────────────────────
        for live_log in conn.live_capture():
            if live_log is None:
                # keepalive tick — device is idle
                continue

            record = _serialise(live_log, users_by_id, users_by_uid)
            if not record:
                continue

            # Refresh user list if we see an unknown user (new enrolment)
            if not record["user_name"] and record["device_user_id"]:
                try:
                    users = conn.get_users() or []
                    users_by_id  = {str(getattr(u, "user_id", "")).strip(): u for u in users}
                    users_by_uid = {str(getattr(u, "uid",     "")).strip(): u for u in users}
                    user = users_by_id.get(record["device_user_id"]) or \
                           users_by_uid.get(record["uid"])
                    record["user_name"] = getattr(user, "name", "") if user else ""
                except Exception:
                    pass

            _emit(record)   # no "type" key → realtime event

    finally:
        try:
            conn.enable_device()
        except Exception:
            pass
        try:
            conn.disconnect()
        except Exception:
            pass


# ── main reconnect loop ───────────────────────────────────────────────────────
def main() -> None:
    p = argparse.ArgumentParser(description="K20 live attendance listener")
    p.add_argument("--host",            default="103.245.195.202")
    p.add_argument("--port",            type=int, default=4370)
    p.add_argument("--password",        type=int, default=0)
    p.add_argument("--timeout",         type=int, default=8)
    p.add_argument("--reconnect-delay", type=int, default=5,
                   dest="reconnect_delay")
    args = p.parse_args()

    _status("warning", f"Listener starting → {args.host}:{args.port}")

    while True:
        try:
            _run_once(args.host, args.port, args.password, args.timeout)
            # live_capture returned (device disconnected gracefully)
            _status("warning", "Live capture ended — reconnecting")
        except (ZKNetworkError, ZKErrorResponse) as e:
            _status("error", f"Device error: {e}")
        except KeyboardInterrupt:
            _status("warning", "Listener stopped by signal")
            sys.exit(0)
        except Exception as e:
            _status("error", f"Unexpected error: {e}")

        time.sleep(args.reconnect_delay)


if __name__ == "__main__":
    main()
