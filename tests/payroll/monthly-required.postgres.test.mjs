import test from "node:test";
import assert from "node:assert/strict";
import {
  setupPayroll,
  company,
  people,
  db,
  as,
} from "./fixtures.mjs";
import { processPayrollRun } from "../../src/services/payrollService.js";
import { getBlockingIssues } from "../../src/services/payrollDashboard.service.js";

// §362 — a manual-monthly employee is paid from the entered payable-days row.
// Without one the engine used to pay a silent full month.
test(
  "manual-monthly payroll is refused until payable days are entered",
  { timeout: 180000 },
  async () => {
    const { run } = await setupPayroll();

    // Publish a manual-monthly profile from 1 September; the employee's own field
    // stays DEVICE, so the published setup must drive the gate.
    await db(async (tx) => {
      const v1 = await tx.attendanceSetupRelease.findFirst({
        where: { tenantId: company, version: 1 },
      });
      const config = structuredClone(v1.config);
      config.settings.profiles = [
        { id: "MANUAL", name: "Headend staff", attendanceInputMode: "MANUAL_MONTHLY" },
      ];
      config.settings.assignments = [
        { employeeId: people.EMPLOYEE.id, profileId: "MANUAL", effectiveFrom: "2026-09-01" },
      ];
      await tx.attendanceSetupRelease.create({
        data: {
          tenantId: company,
          version: 2,
          effectiveFrom: new Date("2026-09-01"),
          coverageThrough: new Date("2026-12-31"),
          reason: "Manual monthly fixture",
          config,
        },
      });
    });
    const employee = await db((tx) =>
      tx.employee.findUnique({ where: { id: people.EMPLOYEE.id } }),
    );
    assert.equal(employee.attendanceInputMode, "DEVICE");

    const issues = await as("EMPLOYEE", () =>
      getBlockingIssues({ tenantId: company, runId: run.id }),
    );
    assert.ok(
      issues.some((i) => i.code === "MONTHLY_ATTENDANCE_REQUIRED"),
      "the run screen lists the missing payable days",
    );

    await assert.rejects(
      () => as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company)),
      (err) => {
        assert.match(err.message, /Enter payable days for September 2026/);
        return true;
      },
    );
    const refused = await db((tx) => tx.payrollRun.findUnique({ where: { id: run.id } }));
    assert.equal(refused.status, "PENDING", "a refused calculation leaves the run untouched");

    // An explicit zero is a real entry: the calculation runs and pays zero days.
    await db((tx) =>
      tx.monthlyPayrollAttendance.create({
        data: {
          tenantId: company,
          employeeId: people.EMPLOYEE.id,
          month: "2026-09",
          payableDays: 0,
          reason: "Unpaid month",
          updatedById: people.HR.id,
        },
      }),
    );
    await as("EMPLOYEE", () => processPayrollRun(run.id, people.EMPLOYEE.id, company));
    const slip = await db((tx) =>
      tx.payrollPayslip.findFirst({
        where: { tenantId: company, payrollRunId: run.id, employeeId: people.EMPLOYEE.id },
      }),
    );
    assert.equal(Number(slip.payableDays), 0);
  },
);
