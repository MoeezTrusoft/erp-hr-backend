// The "Payroll by office" panel on the Payroll Processing screen: getOfficePayroll used to call an undefined
// function (`name`), so the panel failed with a server error for every user. First test this function has had.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, company, other, people, db, as } from "../approval/fixtures.mjs";
import { getOfficePayroll } from "../../src/services/monthlyPayrollAttendance.service.js";

test("office payroll groups payslips by office with employee names and totals", { timeout: 120000 }, async () => {
  await setup();
  const run = await db((tx) =>
    tx.payrollRun.create({ data: { tenantId: company, periodStart: new Date("2031-03-01"), periodEnd: new Date("2031-03-31"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED" } }),
  );
  const slip = (employeeId, payrollOffice, gross, ded) =>
    db((tx) => tx.payrollPayslip.create({ data: { tenantId: company, payrollRunId: run.id, employeeId, payrollOffice, grossAmount: gross, totalDeductions: ded, netAmount: gross - ded, status: "DRAFT" } }));
  await slip(people.EMPLOYEE.id, "Karachi", 1000, 100);
  await slip(people.MANAGER.id, "Karachi", 2000, 0);
  await slip(people.HR.id, null, 500, 50);

  const out = await as("HR", () => getOfficePayroll({ tenantId: company, runId: run.id }));
  assert.equal(out.runId, run.id);
  assert.deepEqual(out.offices.map((o) => o.office), ["Karachi", "Unassigned office"]);
  const karachi = out.offices[0];
  assert.equal(karachi.employees.length, 2);
  assert.equal(karachi.gross, 3000);
  assert.equal(karachi.net, 2900);
  assert.ok(karachi.employees.every((e) => typeof e.name === "string" && e.name.length > 0), "every row carries a display name");
  assert.ok(karachi.employees.every((e) => e.employee === undefined), "the raw employee object is not leaked");
  assert.equal(out.totals.employees, 3);

  // Unknown run: a clean 404, not a server error. Another company's run reads as missing.
  await assert.rejects(() => as("HR", () => getOfficePayroll({ tenantId: company, runId: 999999999 })), (e) => e.status === 404);
  await assert.rejects(() => as("HR", () => getOfficePayroll({ tenantId: other, runId: run.id }), other), (e) => e.status === 404);
});
