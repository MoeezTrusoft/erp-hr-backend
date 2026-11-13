// X4 against Postgres: payroll and capture audit rows are append-only, but the FK cascades
// that reprocessing and the GDPR erase rely on (SET NULL) still work.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, company, people, db } from "../approval/fixtures.mjs";

const refused = (fn, msg) => assert.rejects(fn, (e) => /HR-4203|append-only/.test(String(e?.message ?? e)), msg);

test("audit tables are append-only; FK SET NULL cascades still work", { timeout: 120000 }, async () => {
  await setup();
  const emp = people.EMPLOYEE.id;
  const { run, slip, audit } = await db(async (tx) => {
    const run = await tx.payrollRun.create({ data: { tenantId: company, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-10-31"), countryCode: "PK", currencyCode: "PKR", status: "COMPLETED" } });
    const slip = await tx.payrollPayslip.create({ data: { tenantId: company, payrollRunId: run.id, employeeId: emp, grossAmount: "1", totalDeductions: "0", netAmount: "1", status: "DRAFT" } });
    const audit = await tx.payrollAuditLog.create({ data: { tenantId: company, action: "PAYSLIP_CREATED", payrollRunId: run.id, payslipId: slip.id, employeeId: emp, details: "x", newValues: { a: 1 } } });
    return { run, slip, audit };
  });

  // Refused: edit any content, repoint to another parent, delete.
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { details: "tampered" } })), "details edit");
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { newValues: { a: 2 } } })), "values edit");
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { action: "OTHER" } })), "action edit");
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { tenantId: randomUUID() } })), "tenant move");
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { employeeId: people.MANAGER.id } })), "repoint to another employee");
  await refused(() => db((tx) => tx.payrollAuditLog.delete({ where: { id: audit.id } })), "delete");
  await refused(() => db((tx) => tx.payrollAuditLog.deleteMany({ where: { tenantId: company } })), "bulk delete");

  // Allowed: nulling a parent reference (what the GDPR path does) with all else unchanged.
  await db((tx) => tx.payrollAuditLog.update({ where: { id: audit.id }, data: { payslipId: null } }));
  // Allowed: the real cascade. Deleting the payslip (reprocess) must not be blocked by the guard.
  const second = await db((tx) => tx.payrollAuditLog.create({ data: { tenantId: company, action: "PAYSLIP_REPROCESSED", payrollRunId: run.id, payslipId: slip.id, employeeId: emp, details: "y" } }));
  await db((tx) => tx.payrollPayslip.delete({ where: { id: slip.id } }));
  const after = await db((tx) => tx.payrollAuditLog.findUnique({ where: { id: second.id } }));
  assert.equal(after.payslipId, null, "payslip delete nulls the reference");
  assert.equal(after.details, "y", "content intact");

  // The same row can never be re-pointed at a value once nulled.
  await refused(() => db((tx) => tx.payrollAuditLog.update({ where: { id: second.id }, data: { payslipId: 999999 } })), "re-point after null");

  // Capture audit: fully immutable.
  const cap = await db((tx) => tx.attendanceCaptureAudit.create({ data: { tenantId: company, actorId: "u1", action: "ACCEPTED", reason: "r", detail: {} } }));
  await refused(() => db((tx) => tx.attendanceCaptureAudit.update({ where: { id: cap.id }, data: { reason: "changed" } })), "capture edit");
  await refused(() => db((tx) => tx.attendanceCaptureAudit.delete({ where: { id: cap.id } })), "capture delete");
  const still = await db((tx) => tx.attendanceCaptureAudit.findUnique({ where: { id: cap.id } }));
  assert.equal(still.reason, "r");
});
