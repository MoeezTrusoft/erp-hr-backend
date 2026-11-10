import io
from pathlib import Path
import os
import tempfile
import unittest
from attendance_adms_adapter import ClockCommands, ClockSampler, wrap_handler


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def row(stamp):
    return "101\t%s\t0\t1\t0" % stamp


class SamplerTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.sampler = ClockSampler(self.clock)

    def punch(self, stamp):
        self.sampler.punch_batch("GATE", [row(stamp)])

    def test_one_reading_is_not_enough(self):
        self.punch("2026-11-10 09:00:00")
        self.assertIsNone(self.sampler.device_time("GATE"))

    def test_two_live_punches_give_the_machine_time_even_when_hours_off(self):
        self.punch("2026-11-10 14:00:00")  # the machine says 14:00 ...
        self.clock.now += 600
        self.punch("2026-11-10 14:10:00")  # ... and 10 minutes later 14:10: it ticks like a real clock
        self.clock.now += 30
        self.assertEqual(self.sampler.device_time("GATE"), "2026-11-10 14:10:30")

    def test_a_batch_sent_late_after_an_outage_is_not_trusted(self):
        self.punch("2026-11-10 09:00:00")  # a punch re-sent two hours late
        self.clock.now += 600
        self.punch("2026-11-10 10:50:00")  # another, delayed by a different amount
        self.assertIsNone(self.sampler.device_time("GATE"))

    def test_multi_row_batches_and_bad_rows_are_ignored(self):
        self.sampler.punch_batch("GATE", [row("2026-11-10 09:00:00"), row("2026-11-10 09:01:00")])
        self.sampler.punch_batch("GATE", ["101\tnot a time\t0"])
        self.sampler.punch_batch("GATE", [""])
        self.assertEqual(self.sampler.samples, {})

    def test_an_old_reading_is_dropped(self):
        self.punch("2026-11-10 09:00:00")
        self.clock.now += 60
        self.punch("2026-11-10 09:01:00")
        self.clock.now += 7 * 3600
        self.assertIsNone(self.sampler.device_time("GATE"))

    def test_machines_are_kept_apart(self):
        self.sampler.punch_batch("A", [row("2026-11-10 09:00:00")])
        self.clock.now += 60
        self.sampler.punch_batch("B", [row("2026-11-10 09:01:00")])
        self.assertIsNone(self.sampler.device_time("A"))
        self.assertIsNone(self.sampler.device_time("B"))


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.queue = os.path.join(self.directory.name, "cmds.txt")
        self.clock = Clock()
        self.reports = []

    def commands(self, template):
        return ClockCommands(self.queue, template, lambda sn, body: self.reports.append((sn, body)), self.clock)

    def lines(self):
        return Path(self.queue).read_text().splitlines() if os.path.exists(self.queue) else []

    OFFER = [{"id": "hr-1", "type": "SET_TIME", "localTime": "2026-11-10 15:00:00"}]

    def test_without_a_proven_command_hr_is_told_it_failed_and_nothing_is_queued(self):
        self.commands("").offered("GATE", self.OFFER)
        self.assertEqual(self.lines(), [])
        self.assertEqual(self.reports[0][1]["ok"], False)
        self.assertIn("not set up", self.reports[0][1]["error"])

    def test_the_command_is_queued_once_and_reported_when_the_machine_answers(self):
        c = self.commands("SET OPTIONS DateTime={localTime}")
        c.offered("GATE", self.OFFER)
        c.offered("GATE", self.OFFER)  # the next heartbeat offers it again; it must not be queued twice
        self.assertEqual(self.lines(), ["C:9001:SET OPTIONS DateTime=2026-11-10 15:00:00"])
        c.device_result("GATE", "ID=9001&Return=0&CMD=SET OPTIONS")
        self.assertEqual(self.reports, [("GATE", {"id": "hr-1", "ok": True})])

    def test_a_machine_that_refuses_is_reported_as_failed(self):
        c = self.commands("SET OPTIONS DateTime={localTime}")
        c.offered("GATE", self.OFFER)
        c.device_result("GATE", "ID=9001&Return=-1&CMD=SET OPTIONS")
        self.assertFalse(self.reports[0][1]["ok"])

    def test_an_unanswered_command_is_queued_again_after_a_while(self):
        c = self.commands("SET OPTIONS DateTime={localTime}")
        c.offered("GATE", self.OFFER)
        self.clock.now += 601
        c.offered("GATE", self.OFFER)
        self.assertEqual(len(self.lines()), 2)

    def test_other_command_types_answers_for_unknown_ids_and_junk_are_ignored(self):
        c = self.commands("X {localTime}")
        c.offered("GATE", [{"id": "h", "type": "REBOOT", "localTime": "x"}])
        c.device_result("GATE", "ID=777&Return=0")
        c.device_result("GATE", "garbage")
        self.assertEqual((self.lines(), self.reports), ([], []))


class WiringTests(unittest.TestCase):
    def test_punch_pushes_and_command_answers_reach_the_new_code_and_the_original_receiver(self):
        seen = {}

        class Legacy:
            def _reply(self, body=b"OK", code=200):
                seen["reply"] = code

            def do_GET(self):
                seen["get"] = True

            def do_POST(self):
                seen["legacy_body"] = self.rfile.read()

        clock = Clock()
        sampler = ClockSampler(clock)
        answers = []
        commands = ClockCommands(os.devnull, "", lambda sn, body: answers.append(body), clock)
        Handler = wrap_handler(Legacy, {"GATE"}, lambda sn, t=None: seen.setdefault("beat", t), sampler, commands)
        h = Handler()
        h.headers = {"Content-Length": "30"}
        h.path = "/iclock/cdata?SN=GATE&table=ATTLOG"
        h.rfile = io.BytesIO(row("2026-11-10 09:00:00").encode())
        h.headers = {"Content-Length": str(len(row("2026-11-10 09:00:00")))}
        h.do_POST()
        self.assertEqual(len(sampler.samples["GATE"]), 1, "the punch was sampled")
        self.assertEqual(seen["legacy_body"], row("2026-11-10 09:00:00").encode(), "and the receiver still got the whole body")


if __name__ == "__main__":
    unittest.main()
