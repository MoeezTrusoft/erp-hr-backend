// Attendance cases nobody raised in time are charged when payroll is run; raised and approved ones are not.
import test from "node:test";
import assert from "node:assert/strict";
import { setupPayroll, company, people, db, as } from "./fixtures.mjs";
import { processPayrollRun } from "../../src/services/payrollService.js";
import { previewPayslip } from "../../src/services/payrollPreview.service.js";
process.env.HR_C4_BLIND_INDEX_KEY = Buffer.alloc(32, 19).toString("base64");

let n = 0;
const kase = (date, type, extra = {}) =>
  db((tx) =>
    tx.attendanceAnomaly.create({
      data: {
        tenantId: company,
        employeeId: people.EMPLOYEE.id,
        date: new Date(`${date}T00:00:00Z`),
        type,
        status: "PENDING",
        rulesVersion: 2,
        evidenceState: "ACTIVE",
        sessionKey: `lapse-${++n}`,
        sourceKind: "RULES_V2",
        sourceRef: `rules-v2:lapse:${n}`,
        factHash: `hash-${n}`,
        measuredMinutes: type === "LATE_CHECKIN" ? 45 : null,
        expectedTime: new Date(`${date}T09:00:00Z`),
        actualTime: type === "LATE_CHECKIN" ? new Date(`${date}T09:45:00Z`) : null,
        ...extra,
      },
    }),
  );
const net = async (runId) =>
  Number(
    (await as("EMPLOYEE", () => previewPayslip({ tenantId: company, runId, employeeCode: people.EMPLOYEE.employee_code }))).payslip.netAmount,
  );

test("payroll charges unraised cases past their window, and only those", { timeout: 180000 }, async () => {
  const { run } = await setupPayroll();
  const base = await net(run.id);

  // Raised by HR on the employee's behalf: held until decided, not charged.
  await kase("2026-09-02", "ABSENT", { raisedById: people.HR.id });
  assert.equal(await net(run.id), base);

  // Nobody raised it and the two working days have passed: charged one day (the configured absence).
  const lapsed = await kase("2026-09-04", "ABSENT");
  const charged = await net(run.id);
  assert.ok(charged < base, `expected a deduction, net ${charged} vs ${base}`);

  // HR raises it before payroll is submitted: the charge is released on the next calculation.
  await db((tx) => tx.attendanceAnomaly.update({ where: { id: lapsed.id }, data: { raisedById: people.HR.id } }));
  assert.equal(await net(run.id), base);

  // Un-raise it again (HR withdrew): charged again, and processing prices the same as the preview.
  await db((tx) => tx.attendanceAnomaly.update({ where: { id: lapsed.id }, data: { raisedById: null } }));
  const charged2 = await net(run.id);
  assert.equal(charged2, charged);
  const calculated = await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
  assert.equal(Number(calculated.totalNet), charged2);
});
