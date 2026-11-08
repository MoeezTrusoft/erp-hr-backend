// O-05 against Postgres: the service gathers devices, raised requests, runs and holds, tenant-scoped.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { setup, company, people, db, as } from "../approval/fixtures.mjs";
import { opsHealth } from "../../src/services/opsHealth.service.js";

const DAY = 86400000;
// Activating a device needs the onsite-acceptance workflow (DB guard). This test is only about
// reading health, so switch the guard off on the isolated test DB while the rows go in.
const adminSql = async (sql) => {
  const c = new pg.Client({ connectionString: process.env.ASSESSMENT_TEST_ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
};

test("ops health: stale device, aged raised request, open run, held payslip; isolation; validation", { timeout: 120000 }, async () => {
  await setup();
  const now = new Date("2026-11-09T12:00:00Z");
  const ago = (ms) => new Date(+now - ms);
  const emp = people.EMPLOYEE.id;

  await adminSql("ALTER TABLE attendance_capture_devices DISABLE TRIGGER attendance_device_activation_guard");
  await db((tx) =>
    tx.attendanceCaptureDevice.create({ data: { tenantId: company, sn: `HEALTH-${randomUUID().slice(0, 8)}`, name: "Stale gate", timeZone: "Asia/Karachi", active: true, lastSeenAt: ago(3 * 3600000), staleAfterMinutes: 30 } }),
  );
  await db((tx) =>
    tx.attendanceCaptureDevice.create({ data: { tenantId: company, sn: `HEALTH-${randomUUID().slice(0, 8)}`, name: "Fresh gate", timeZone: "Asia/Karachi", active: true, lastSeenAt: ago(60000), staleAfterMinutes: 30 } }),
  );
  await adminSql("ALTER TABLE attendance_capture_devices ENABLE TRIGGER attendance_device_activation_guard");
  const mkCase = (extra) => db((tx) => tx.attendanceAnomaly.create({ data: { tenantId: company, employeeId: emp, type: "LATE_CHECKIN", date: ago(9 * DAY), status: "PENDING", evidenceState: "ACTIVE", ...extra } }));
  const aged = await mkCase({ sourceKind: "PAPER_FORM", createdAt: ago(9 * DAY) });
  await mkCase({ sourceKind: "PAPER_FORM", createdAt: ago(1 * DAY) }); // too recent
  await mkCase({ sourceKind: "RULES_V2", raisedById: null, createdAt: ago(9 * DAY) }); // unraised: charged at payroll, not an open request
  await mkCase({ sourceKind: "PAPER_FORM", createdAt: ago(9 * DAY), status: "RESOLVED", evidenceState: "RESOLVED" }); // decided

  const run = await db(async (tx) => {
    const r = await tx.payrollRun.create({ data: { tenantId: company, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-31"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED" } });
    await tx.payrollPayslip.create({ data: { tenantId: company, payrollRunId: r.id, employeeId: emp, grossAmount: "1", totalDeductions: "0", netAmount: "1", status: "HOLD" } });
    return r;
  });
  await db((tx) => tx.payrollRun.create({ data: { tenantId: company, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-30"), countryCode: "PK", currencyCode: "PKR", status: "CANCELLED" } }));

  const r = await as("HR", () => opsHealth({ tenantId: company, now }));
  const get = (code) => r.checks.find((c) => c.code === code);
  assert.equal(r.overall, "ATTENTION");
  assert.deepEqual(get("DEVICE_STALE").items.map((d) => d.name), ["Stale gate"]);
  assert.deepEqual(get("CASES_AGED").items.map((c) => c.id), [aged.id]);
  assert.deepEqual(get("RUNS_NOT_CLOSED").items.map((x) => x.id), [run.id]);
  assert.equal(get("PAYSLIPS_HELD").count, 1);

  // Another company sees none of it.
  const other = randomUUID();
  const clean = await as("HR", () => opsHealth({ tenantId: other, now }), other);
  assert.equal(clean.overall, "OK");

  await assert.rejects(as("HR", () => opsHealth({ tenantId: company, now: new Date("nope") })), /valid date/);
});
