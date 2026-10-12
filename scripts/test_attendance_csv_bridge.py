import csv
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from attendance_csv_bridge import forward_file, fresh_poll
from attendance_adms_adapter import wrap_handler


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "2026-10.csv"
        with self.path.open("w", newline="") as stream:
            csv.writer(stream).writerow(["timestamp_device", "user_id", "punch_code", "status_code"])
        self.state = {}
        self.sent = []

    def append(self, stamp):
        with self.path.open("a", newline="") as stream:
            csv.writer(stream).writerow([stamp, "101", "0", "0"])

    def deliver(self, send=None):
        return forward_file(self.path, self.state, "2026-10-13", send or self.sent.extend, lambda: None)

    def test_late_appended_punch_and_restart_do_not_lose_or_repeat_rows(self):
        self.append("2026-10-12 18:00:00")
        self.append("2026-10-13 09:00:00")
        self.assertEqual(self.deliver(), 1)
        self.assertEqual(self.deliver(), 0)
        self.append("2026-10-13 08:00:00")
        self.assertEqual(self.deliver(), 1)
        self.assertEqual(len(self.sent), 2)

    def test_failed_delivery_does_not_advance_checkpoint(self):
        self.append("2026-10-13 09:00:00")
        def failed(_):
            raise OSError("unavailable")
        with self.assertRaises(OSError):
            self.deliver(failed)
        self.assertEqual(self.state, {})
        self.assertEqual(self.deliver(), 1)

    def test_changed_previously_delivered_records_are_held(self):
        self.append("2026-10-13 09:00:00")
        self.deliver()
        self.path.write_text(self.path.read_text().replace("09:00", "10:00"))
        with self.assertRaisesRegex(ValueError, "Previously delivered"):
            self.deliver()

    def test_partial_append_waits_without_checkpointing(self):
        with self.path.open("a") as stream:
            stream.write("2026-10-13 09:00:00,101,0")
        self.assertEqual(self.deliver(), 0)
        self.assertEqual(self.state, {})

    def test_only_fresh_completed_hardware_poll_can_refresh_health(self):
        now = datetime(2026, 10, 13, 4, tzinfo=timezone.utc)
        info = {"polled_at": "2026-10-13T03:59:00+00:00"}
        self.assertTrue(fresh_poll(info, {"last_ok": "2026-10-13T03:59:10+00:00"}, now))
        self.assertFalse(fresh_poll(info, {"last_ok": "2026-10-12T03:59:10+00:00"}, now))
        self.assertFalse(fresh_poll(info, {"last_ok": "2026-10-13T03:58:50+00:00"}, now))


class AdmsTests(unittest.TestCase):
    def receiver(self, serial):
        class Legacy:
            headers = {}
            replies = []
            forwarded = False
            def _reply(self, body, code=200):
                self.replies.append(code)
            def do_GET(self):
                self.forwarded = True
            def do_POST(self):
                self.forwarded = True
        beats = []
        instance = wrap_handler(Legacy, {"REGISTERED"}, beats.append)()
        instance.path = "/iclock/getrequest?SN=" + serial
        return instance, beats

    def test_unknown_serial_cannot_use_bridge_credential(self):
        receiver, beats = self.receiver("UNKNOWN")
        receiver.do_GET()
        self.assertEqual(receiver.replies, [403])
        self.assertFalse(receiver.forwarded)
        self.assertEqual(beats, [])

    def test_live_device_poll_refreshes_health_without_creating_a_punch(self):
        receiver, beats = self.receiver("REGISTERED")
        receiver.do_GET()
        receiver.do_GET()
        self.assertEqual(beats, ["REGISTERED"])
        self.assertTrue(receiver.forwarded)

    def test_oversized_upload_is_rejected_before_legacy_body_read(self):
        receiver, _ = self.receiver("REGISTERED")
        receiver.headers = {"Content-Length": str(9 * 1024 * 1024)}
        receiver.do_POST()
        self.assertEqual(receiver.replies, [413])
        self.assertFalse(receiver.forwarded)


if __name__ == "__main__":
    unittest.main()
