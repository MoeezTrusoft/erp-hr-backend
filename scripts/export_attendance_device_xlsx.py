#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from zk import ZK
from zk.exception import ZKNetworkError


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Export ZKTeco attendance logs to XLSX")
    p.add_argument("--host", default="103.245.195.202", help="Device IP/host")
    p.add_argument("--port", type=int, default=4370, help="Device TCP port")
    p.add_argument("--password", type=int, default=0, help="Device communication password")
    p.add_argument("--timeout", type=int, default=15, help="Socket timeout seconds")
    p.add_argument("--year", type=int, default=datetime.now().year, help="Filter year")
    p.add_argument("--month", type=int, choices=range(1, 13), help="Filter month (1-12). Omit for all months")
    p.add_argument("--force-udp", action="store_true", help="Try UDP instead of TCP")
    p.add_argument(
        "--output",
        default=None,
        help="Output XLSX path. Default: ./result/attendance_with_names_<date>.xlsx",
    )
    return p


def resolve_output_path(args) -> Path:
    script_dir = Path(__file__).resolve().parent
    result_dir = script_dir / "result"
    result_dir.mkdir(parents=True, exist_ok=True)

    if args.output:
        return Path(args.output).expanduser().resolve()

    stamp = datetime.now().strftime("%Y-%m-%d")
    suffix = f"_{args.year}-{args.month:02d}" if args.month else f"_{args.year}_all"
    return result_dir / f"attendance_with_names{suffix}_{stamp}.xlsx"


def export_attendance(
    host: str,
    port: int,
    password: int,
    timeout: int,
    year: int,
    month: int | None,
    output: Path,
    force_udp: bool = False,
) -> tuple[int, int, int]:
    zk = ZK(
        host,
        port=port,
        timeout=timeout,
        password=password,
        force_udp=force_udp,
        ommit_ping=True,
    )
    conn = None

    try:
        print(
            f"[INFO] Connecting to device host={host} port={port} "
            f"force_udp={force_udp} timeout={timeout}",
            flush=True,
        )
        conn = zk.connect()
        print("[INFO] Connected successfully", flush=True)

        conn.disable_device()

        users = conn.get_users() or []
        logs = conn.get_attendance() or []

        users_by_user_id = {str(getattr(u, "user_id", "")).strip(): u for u in users}
        users_by_uid = {str(getattr(u, "uid", "")).strip(): u for u in users}

        rows = []
        for log in logs:
            ts = getattr(log, "timestamp", None)
            if not ts:
                continue
            if ts.year != year:
                continue
            if month is not None and ts.month != month:
                continue

            device_user_id = str(getattr(log, "user_id", "")).strip()
            uid = str(getattr(log, "uid", "")).strip()
            user = users_by_user_id.get(device_user_id) or users_by_uid.get(uid)

            rows.append(
                {
                    "timestamp": ts,
                    "date": ts.date().isoformat(),
                    "time": ts.strftime("%H:%M:%S"),
                    "employee_name": getattr(user, "name", "") if user else "",
                    "device_user_id": device_user_id,
                    "uid": uid,
                    "status": getattr(log, "status", ""),
                    "punch": getattr(log, "punch", ""),
                    "card": getattr(user, "card", "") if user else "",
                    "privilege": getattr(user, "privilege", "") if user else "",
                }
            )

        rows.sort(key=lambda r: r["timestamp"])

        wb = Workbook()
        ws = wb.active
        ws.title = "Attendance Logs"
        ws.append(
            [
                "Timestamp",
                "Date",
                "Time",
                "EmployeeName",
                "DeviceUserID",
                "UID",
                "Status",
                "Punch",
                "Card",
                "Privilege",
            ]
        )

        for row in rows:
            ws.append(
                [
                    row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),
                    row["date"],
                    row["time"],
                    row["employee_name"],
                    row["device_user_id"],
                    row["uid"],
                    row["status"],
                    row["punch"],
                    row["card"],
                    row["privilege"],
                ]
            )

        widths = {
            "A": 22,
            "B": 12,
            "C": 10,
            "D": 28,
            "E": 14,
            "F": 8,
            "G": 10,
            "H": 10,
            "I": 16,
            "J": 10,
        }
        for col, width in widths.items():
            ws.column_dimensions[col].width = width

        wsu = wb.create_sheet("User Master")
        wsu.append(["UID", "DeviceUserID", "EmployeeName", "Card", "Privilege", "GroupID"])
        for user in sorted(users, key=lambda u: str(getattr(u, "user_id", "")).strip()):
            wsu.append(
                [
                    getattr(user, "uid", ""),
                    str(getattr(user, "user_id", "")).strip(),
                    getattr(user, "name", ""),
                    getattr(user, "card", ""),
                    getattr(user, "privilege", ""),
                    getattr(user, "group_id", ""),
                ]
            )

        wsu_widths = {"A": 8, "B": 14, "C": 28, "D": 16, "E": 10, "F": 12}
        for col, width in wsu_widths.items():
            wsu.column_dimensions[col].width = width

        output.parent.mkdir(parents=True, exist_ok=True)
        wb.save(output)

        mapped = sum(1 for r in rows if r["employee_name"])
        return len(rows), len(users), mapped

    finally:
        if conn:
            try:
                conn.enable_device()
            except Exception:
                pass
            try:
                conn.disconnect()
            except Exception:
                pass


def main() -> None:
    args = build_parser().parse_args()
    output = resolve_output_path(args)

    try:
        rows, users, mapped = export_attendance(
            host=args.host,
            port=args.port,
            password=args.password,
            timeout=args.timeout,
            year=args.year,
            month=args.month,
            output=output,
            force_udp=args.force_udp,
        )
        print(f"file={output}")
        print(f"rows={rows}")
        print(f"users={users}")
        print(f"name_filled_rows={mapped}")

    except ZKNetworkError as e:
        print(f"[ERROR] Device network/protocol connection failed: {e}", file=sys.stderr)
        print("[HINT] TCP port may be open, but the device may be rejecting the ZKTeco handshake.", file=sys.stderr)
        print("[HINT] Check device comm password, local LAN IP, NAT/port-forwarding, or try --force-udp.", file=sys.stderr)
        sys.exit(1)

    except Exception as e:
        print(f"[ERROR] Unexpected failure: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()