// Capture against PostgreSQL: a manual punch is a request the attendance route approves and is recorded only on the
// final approval; a machine with a wrong clock has its punches counted at the server's time (the machine's own reading
// kept), and HR can ask the machine to set its clock.
import test from "node:test";
import pg from "pg";
import assert from "node:assert/strict";
import { company, other, people, db, as, act, prisma, ensure, publishRoute, decide, approvalOf } from "./route-fixture.mjs";
const manual = await import("../../src/services/captureChangeRequest.service.js");
const capture = await import("../../src/services/attendanceCapture.service.js");
const commands = await import("../../src/services/attendanceDeviceCommand.service.js");
const attendance = await import("../../src/services/attendance.service.js");
const { mcpCtx } = await import("../../src/mcp/context.js");
const { tenantTransaction } = await import("../../src/lib/rlsTenant.js");

const hr = (fn) => as("BOTH", fn);
const asker = () => ({ tenantId: company, requestedById: people.BOTH.id });
const stamp = (daysAgo, time) => {
  const d = new Date(Date.now() - daysAgo * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
  return `${d} ${time}`;
};
const ask = (over = {}) => hr(() => manual.requestManualPunch({ ...asker(), employeeId: people.EMPLOYEE.id, direction: "IN", timestamp: stamp(3, "09:05:00"), reason: "Forgot to punch at the gate", ...over }));
const events = (where = {}) => db((tx) => tx.attendanceCaptureEvent.findMany({ where: { tenantId: company, ...where }, orderBy: { createdAt: "asc" } }));
const audits = (action) => db((tx) => tx.attendanceCaptureAudit.findMany({ where: { tenantId: company, action } }));
const rejectWaiting = async (id) => {
  const ar = await approvalOf("CAPTURE_CHANGE", id);
  const rec = { approvalRef: ar.id, version: ar.version };
  await act("MANAGEMENT", rec, "REJECT").catch(() => act("HR", rec, "REJECT"));
};

test("a manual punch needs the route, a reason, a real past time and an employee; nothing is left behind", async () => {
  await ensure();
  await assert.rejects(ask(), /Publish the attendance approval route/);
  assert.equal(await db((tx) => tx.captureChangeRequest.count({ where: { tenantId: company } })), 0, "no orphan request");
  await publishRoute();
  await assert.rejects(ask({ reason: " " }), /reason/i);
  await assert.rejects(ask({ direction: "SIDEWAYS" }), /check-in or check-out/);
  await assert.rejects(ask({ employeeId: 999999 }), /Employee not found/);
  await assert.rejects(ask({ timestamp: "yesterday" }), /YYYY-MM-DD HH:mm:ss/);
  await assert.rejects(ask({ timestamp: "2026-02-30 09:00:00" }), /YYYY-MM-DD HH:mm:ss/);
  await assert.rejects(ask({ timestamp: stamp(-2, "09:00:00") }), /cannot be in the future/);
  await assert.rejects(hr(() => manual.requestManualPunch({ ...asker(), requestedById: null, employeeId: people.EMPLOYEE.id, direction: "IN", reason: "x y z" })), /employee account/);
  assert.equal(await db((tx) => tx.captureChangeRequest.count({ where: { tenantId: company } })), 0);
});

test("a manual punch is recorded only on the final approval, once, with the reason kept", async () => {
  await ensure();
  const before = (await events()).length;
  const filed = await ask();
  assert.equal(filed.pendingApproval, true);
  assert.equal((await events()).length, before, "nothing is recorded while the request waits");
  await assert.rejects(ask(), /already has a request waiting/);
  const waiting = await hr(() => manual.listPendingCaptureChanges({ tenantId: company }));
  assert.equal(waiting.length, 1);
  assert.ok(waiting[0].requestedByName);
  assert.match(waiting[0].payload.changes[0], /Add a check-in for .* at /);

  assert.equal((await decide("CAPTURE_CHANGE", filed.requestId)).stage, "APPROVED");
  const stored = (await events()).slice(before);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "MANUAL");
  assert.equal(stored[0].employeeId, people.EMPLOYEE.id);
  assert.match(stored[0].raw.notes, /Forgot to punch at the gate/);
  assert.equal(stored[0].parsed.status, 0, "a check-in");
  assert.equal(await db((tx) => tx.payrollAuditLog.count({ where: { tenantId: company, action: "CAPTURE_CHANGE_APPLIED" } })), 1);
  assert.equal((await hr(() => manual.listPendingCaptureChanges({ tenantId: company }))).length, 0);

  // The same punch asked for again after approval is the same evidence, not a second punch.
  const again = await ask();
  await decide("CAPTURE_CHANGE", again.requestId);
  assert.equal((await events()).filter((e) => e.source === "MANUAL" && e.employeeId === people.EMPLOYEE.id).length, 1, "a duplicate punch is kept once");
});

test("a rejected manual punch records nothing; a check-out is a check-out", async () => {
  await ensure();
  const before = (await events()).length;
  const rejected = await ask({ direction: "OUT", timestamp: stamp(3, "17:30:00") });
  assert.equal((await decide("CAPTURE_CHANGE", rejected.requestId, "REJECT")).stage, "REJECTED");
  assert.equal((await events()).length, before);
  const ok = await ask({ direction: "OUT", timestamp: stamp(3, "17:31:00") });
  await decide("CAPTURE_CHANGE", ok.requestId);
  assert.equal((await events()).at(-1).parsed.status, 1);
});

test("a manual punch is refused for a day a payroll run covers, when filed and at approval", async () => {
  await ensure();
  const filed = await ask({ timestamp: stamp(4, "09:10:00") });
  const run = await db((tx) => tx.payrollRun.create({ data: { tenantId: company, processedBy: people.HR.id, periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2099-12-31T00:00:00Z"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED", totalGross: 1, totalNet: 1 } }));
  try {
    await assert.rejects(ask({ timestamp: stamp(5, "09:10:00") }), /payroll run/i, "refused up front");
    await assert.rejects(decide("CAPTURE_CHANGE", filed.requestId), /payroll run/i, "and at the last level");
  } finally {
    await db((tx) => tx.payrollRun.delete({ where: { id: run.id } }));
    await rejectWaiting(filed.requestId);
  }
});

test("the old direct manual-punch writers are closed", async () => {
  await ensure();
  await assert.rejects(attendance.createAttendanceService({ tenantId: company, employeeId: people.EMPLOYEE.id }), /sent for approval first/);
  await assert.rejects(attendance.checkOutServiceWithTimestamp(people.EMPLOYEE.id, undefined, company), /sent for approval first/);
});

// ── machines with a wrong clock ───────────────────────────────────────────────────────────────────────────────
const SN = "CLOCK-TEST-1";
let device;
const setClock = (offsetSeconds, sampledAt = new Date()) =>
  db((tx) => tx.attendanceCaptureDevice.update({ where: { id: device.id }, data: { clockOffsetSeconds: offsetSeconds, clockSampledAt: sampledAt, lastSeenAt: new Date() } }));
const push = (rows, requestKey) => mcpCtx.run({ system: true }, () => capture.receiveCapture({ sn: SN, rows, requestKey }));
const nowLocal = (minutesAgo = 5) => new Date(Date.now() - minutesAgo * 60000).toLocaleString("sv-SE", { timeZone: "Asia/Karachi" });
const shifted = (text, hours) => {
  const t = new Date(`${text.replace(" ", "T")}Z`); // wall time as pseudo-UTC, shifted by whole hours
  return new Date(+t + hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
};
const eventFor = async (rawLine) => (await events({ sn: SN })).find((e) => e.raw?.line === rawLine);

test("a machine 3 hours ahead: its punch counts at the server's time, the machine's own time is kept", async () => {
  await ensure();
  device = await db((tx) => tx.attendanceCaptureDevice.create({ data: { tenantId: company, sn: SN, name: "Gate", timeZone: "Asia/Karachi", active: false, allowedTenantIds: [company] } }));
  // Activation normally needs the reviewed onsite-acceptance workflow; this test is about the clock, so the guard is skipped.
  const admin = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await admin.connect();
  await admin.query("SET session_replication_role = replica");
  await admin.query("UPDATE attendance_capture_devices SET active = true WHERE id = $1", [device.id]);
  await admin.end();
  await db((tx) => tx.employeeDeviceEnrolment.create({ data: { tenantId: company, employeeId: people.EMPLOYEE.id, deviceUserId: "101", sn: SN, effectiveFrom: new Date("2026-01-01") } }));
  const real = nowLocal(5);
  const machine = shifted(real, 3);
  await setClock(10800);
  const line = `101\t${machine}\t0\t1\t0`;
  const summary = await push([line]);
  assert.equal(summary.clockCorrected, 1);
  const event = await eventFor(line);
  assert.equal(event.parsed.localTime.slice(0, 19), real.replace(" ", "T"), "counted at the server's time");
  assert.equal(event.parsed.machine.localTime.slice(0, 19), machine.replace(" ", "T"), "the machine's reading is kept");
  assert.equal(event.parsed.clockOffsetSeconds, 10800);
  assert.equal(event.state, "PENDING", "and it is processed like any punch");
  const audit = (await audits("CLOCK_CORRECTED")).at(-1);
  assert.match(audit.reason, /3 hours ahead of the server/);

  // The same punch delivered again is the same punch, whether or not the clock is still being corrected.
  const stillWrong = (await audits("DUPLICATE_RECEIVED")).length;
  await push([line], "replay-0");
  assert.equal((await audits("DUPLICATE_RECEIVED")).length, stillWrong + 1, "recognised as a repeat while the correction is still applied");
  await setClock(0);
  const before = (await events({ sn: SN })).length;
  const repeatsBefore = (await audits("DUPLICATE_RECEIVED")).length;
  const replay = await push([line], "replay-1");
  assert.equal(replay.stored, 0);
  assert.equal((await events({ sn: SN })).length, before, "a repeat never looks new because the offset changed");
  assert.equal((await audits("DUPLICATE_RECEIVED")).length, repeatsBefore + 1, "and it is recognised as a repeat, not silently dropped");
});

test("no correction when the clock is right, was not measured recently, or the machine is only slightly off", async () => {
  await ensure();
  const check = async (offset, sampledAt, expectCorrected) => {
    await setClock(offset, sampledAt);
    const real = nowLocal(20 + Math.floor(Math.random() * 1000) / 100);
    const machine = offset ? shifted(real, 2) : real;
    const line = `101\t${machine}\t1\t1\t0`;
    const result = await push([line]);
    assert.equal(Boolean(result.clockCorrected), expectCorrected, `offset ${offset}`);
    return eventFor(line);
  };
  await check(0, new Date(), false);
  await check(90, new Date(), false); // within the 2-minute tolerance
  const stale = await check(7200, new Date(Date.now() - 7 * 3600000), false); // reading older than 6 hours
  assert.equal(stale.parsed.machine, undefined, "untouched");
});

test("a punch still more than a day ahead after correction is held for a person to look at", async () => {
  await ensure();
  await setClock(0);
  const line = `101\t${shifted(nowLocal(1), 24 * 9)}\t0\t1\t0`;
  const result = await push([line]);
  assert.equal(result.needsReview, 1);
  const event = await eventFor(line);
  assert.equal(event.state, "NEEDS_REVIEW");
  assert.match(event.reason, /more than a day ahead/);
});

test("HR can ask a drifting machine to set its clock; the agent gets it at the heartbeat and confirms", async () => {
  await ensure();
  const fix = () => hr(() => commands.requestClockFix({ tenantId: company, actorId: people.BOTH.id, sn: SN }));
  await setClock(30);
  await assert.rejects(fix(), /already correct/);
  await db((tx) => tx.attendanceCaptureDevice.update({ where: { id: device.id }, data: { clockOffsetSeconds: null, clockSampledAt: null } }));
  await assert.rejects(fix(), /not reported its time yet/);
  await assert.rejects(hr(() => commands.requestClockFix({ tenantId: company, actorId: people.BOTH.id, sn: "NOPE" })), /not found/);
  await assert.rejects(mcpCtx.run({ user: { tenantId: other } }, () => commands.requestClockFix({ tenantId: other, actorId: 1, sn: SN })), /not found|does not own/, "another company cannot touch this machine");

  await setClock(10800);
  const command = await fix();
  assert.equal(command.state, "PENDING");
  await assert.rejects(fix(), /already waiting/);
  assert.equal((await audits("CLOCK_FIX_REQUESTED")).length, 1);

  // The agent's heartbeat reports the clock still wrong and receives the command with the server's time.
  const beat = await capture.captureHeartbeat({ device: { ...device }, deviceTime: shifted(nowLocal(0), 3).replace(" ", " ") });
  assert.equal(beat.commands.length, 1);
  assert.equal(beat.commands[0].type, "SET_TIME");
  assert.ok(beat.commands[0].localTime && beat.commands[0].timeZone === "Asia/Karachi");
  const sent = (await db((tx) => tx.attendanceDeviceCommand.findUnique({ where: { id: command.id } })));
  assert.equal(sent.state, "SENT");
  const again = await capture.captureHeartbeat({ device: { ...device }, deviceTime: shifted(nowLocal(0), 3) });
  assert.equal(again.commands.length, 1, "an unacknowledged command is offered again");

  await commands.ackCommand({ device, id: command.id, ok: true });
  assert.equal((await db((tx) => tx.attendanceDeviceCommand.findUnique({ where: { id: command.id } }))).state, "APPLIED");
  await assert.rejects(commands.ackCommand({ device, id: command.id, ok: true }), /No open command/, "acknowledged once");
});

test("a failed command is shown as failed, and a heartbeat with a good clock closes a waiting one", async () => {
  await ensure();
  await setClock(7200);
  const failing = await hr(() => commands.requestClockFix({ tenantId: company, actorId: people.BOTH.id, sn: SN }));
  await commands.ackCommand({ device, id: failing.id, ok: false, error: "Device refused the time" });
  const row = await db((tx) => tx.attendanceDeviceCommand.findUnique({ where: { id: failing.id } }));
  assert.equal(row.state, "FAILED");
  assert.match(row.detail.error, /refused/);

  const waiting = await hr(() => commands.requestClockFix({ tenantId: company, actorId: people.BOTH.id, sn: SN }));
  const fixed = await capture.captureHeartbeat({ device: { ...device }, deviceTime: nowLocal(0) });
  assert.deepEqual(fixed.commands, [], "nothing left to do once the clock is right");
  assert.equal((await db((tx) => tx.attendanceDeviceCommand.findUnique({ where: { id: waiting.id } }))).state, "APPLIED");
  const listed = await hr(() => commands.listClockCommands({ tenantId: company }));
  assert.deepEqual(listed.map((c) => c.state).sort(), ["APPLIED", "APPLIED", "FAILED"]);

  const overview = await hr(() => capture.captureOverview({ tenantId: company }));
  const gate = overview.devices.find((d) => d.sn === SN);
  assert.equal(gate.clockDrifting, false);
});

test("the overview says in words that a machine's clock is off", async () => {
  await ensure();
  await setClock(-5400);
  const overview = await hr(() => capture.captureOverview({ tenantId: company }));
  const gate = overview.devices.find((d) => d.sn === SN);
  assert.equal(gate.clockDrifting, true);
  assert.equal(gate.clockNote, "1 hour 30 minutes behind the server");
});

test("commands and manual-punch requests are invisible to other companies", async () => {
  await ensure();
  const seen = await mcpCtx.run({ user: { tenantId: other } }, () =>
    tenantTransaction(prisma, async (tx) => [await tx.attendanceDeviceCommand.count(), await tx.captureChangeRequest.count()], { tenantId: other }));
  assert.deepEqual(seen, [0, 0]);
  assert.equal((await mcpCtx.run({ user: { tenantId: other } }, () => manual.listPendingCaptureChanges({ tenantId: other }))).length, 0);
  await assert.rejects(db((tx) => tx.captureChangeRequest.updateMany({ where: { tenantId: company }, data: { status: "APPROVED" } })), /staged approval/);
});
