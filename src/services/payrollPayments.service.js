import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import * as money from "../lib/money.js";
import { identitiesByCode } from "../lib/personIdentity.js";
import { encryptString, decryptString } from "../lib/crypto.js";
const historyOf = (value) =>
  value?.encrypted
    ? JSON.parse(decryptString(value.encrypted))
    : Array.isArray(value)
      ? value
      : [];
export const payrollPaymentStage = (value) =>
  historyOf(value).at(-1)?.stage || "NOT_SUBMITTED";

export const COMPANY_PAYROLL_BANKS = Object.freeze({
  "8ff0533b-62f6-4be9-a78e-69adf49e00bc": {
    company: "HomeNet",
    bank: "Faysal Bank",
  },
  "14d8c7b1-194d-4e35-b058-b9cb9aa9fba2": { company: "BOC", bank: "UBL" },
  "8f4a526f-d45b-4da2-b772-d6682e849812": { company: "JOC", bank: "UBL" },
  "40314ef4-0a81-4390-b631-b3ad3f21f523": {
    company: "TruSoft",
    bank: "Bank Alfalah",
  },
  "61b7eb53-ab6e-413f-9d9a-1ecf4e071e73": {
    company: "HomeVision",
    bank: "Meezan Bank",
  },
});
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
// Whether the payroll setup this run was calculated with pays salaries in cash.
async function runPaysInCash(db, tenantId, run) {
  const snapshot = await db.payrollConfigSnapshot.findFirst({
    where: {
      tenantId,
      ...(run?.calculationConfigVersion ? { version: run.calculationConfigVersion } : {}),
    },
    orderBy: { version: "desc" },
  });
  return snapshot?.config?.payRules?.cashDisbursement === true;
}

export async function payrollPaymentStatus({ tenantId, runId }) {
  const run = await prisma.payrollRun.findFirst({
    where: { tenantId, id: runId },
  });
  if (!run) fail("Payroll run not found", 404);
  const slips = await prisma.payrollPayslip.findMany({
    where: { tenantId, payrollRunId: runId },
    include: { employee: { select: { employee_code: true } } },
    orderBy: { id: "asc" },
  });
  const people = await identitiesByCode(
    prisma,
    tenantId,
    slips.map((s) => s.employee.employee_code),
  );
  return {
    runId,
    status: run.status,
    currency: run.currencyCode,
    provider: COMPANY_PAYROLL_BANKS[tenantId] || null,
    cashDisbursement: await runPaysInCash(prisma, tenantId, run),
    integration: "EVIDENCE_RECORDING",
    items: slips.map((s) => ({
      employeeCode: s.employee.employee_code,
      employee: people.get(s.employee.employee_code) ?? null,
      netAmount: s.netAmount,
      paidAt: s.paidAt,
      reference: s.paymentReference,
      method: historyOf(s.paymentEvidence).at(-1)?.method ?? null,
      status: historyOf(s.paymentEvidence).at(-1)?.stage || "NOT_SUBMITTED",
      history: historyOf(s.paymentEvidence),
    })),
  };
}

// Evidence records describe actions performed at the bank. No API submission is
// implied. Only a reconciled credit establishes paidAt on the employee's payslip.
export async function recordPayrollPayment({
  tenantId,
  runId,
  employeeCode,
  actorCode,
  stage,
  reference,
  evidenceRef,
  amount,
  currency,
  occurredAt,
  requestKey,
}) {
  // An unbound session has no code; Prisma drops `employee_code: undefined`
  // from the filter, so the lookup below would match any employee.
  if (typeof actorCode !== "string" || !actorCode.trim())
    fail("A verified employee code is required to record payment", 403);
  if (!["SUBMITTED", "ACKNOWLEDGED", "REJECTED", "RECONCILED"].includes(stage))
    fail("Invalid payment stage", 400);
  if (!reference?.trim() || !evidenceRef?.trim() || !requestKey)
    fail(
      "A bank reference, evidence reference and request key are required",
      400,
    );
  const when = new Date(occurredAt);
  if (!Number.isFinite(+when) || +when > Date.now())
    fail(
      "Payment evidence date must be valid and cannot be in the future",
      400,
    );
  return tenantTransaction(
    prisma,
    async (tx) => {
      const actor = await tx.employee.findFirst({
        where: { tenant_id: tenantId, employee_code: actorCode },
      });
      if (!actor)
        fail("A verified employee code is required to record payment", 403);
      const run = await tx.payrollRun.findFirst({
        where: { tenantId, id: runId },
      });
      if (run?.status !== "FINALIZED")
        fail("Finalize the approved payroll before recording bank activity");
      const slip = await tx.payrollPayslip.findFirst({
        where: {
          tenantId,
          payrollRunId: runId,
          employee: { employee_code: employeeCode },
        },
      });
      if (!slip) fail("Employee code not found in this payroll", 404);
      await tx.$queryRaw`SELECT id FROM payroll_payslips WHERE id=${slip.id} AND "tenantId"=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.payrollPayslip.findFirst({
        where: { tenantId, id: slip.id },
      });
      const history = historyOf(current.paymentEvidence);
      const event = {
        requestKey,
        stage,
        reference: reference.trim(),
        evidenceRef: evidenceRef.trim(),
        amount: String(amount),
        currency,
        occurredAt: when.toISOString(),
        actorCode,
      };
      const retry = history.find((e) => e.requestKey === requestKey);
      if (retry) {
        if (JSON.stringify(retry) !== JSON.stringify(event))
          fail("Request key was already used for different payment evidence");
        return { employeeCode, status: stage };
      }
      if (
        currency !== run.currencyCode ||
        money.decimalToMinor(amount, currency) !==
          money.decimalToMinor(current.netAmount, currency) ||
        Number(amount) <= 0
      )
        fail(
          "Bank amount and currency must exactly match the finalized net pay",
        );
      if (!["FINALIZED", "DISTRIBUTED"].includes(current.status))
        fail("Held or draft payslips cannot be paid");
      const last = history.at(-1),
        previous = last?.stage || "NOT_SUBMITTED";
      const allowed = {
        NOT_SUBMITTED: ["SUBMITTED"],
        SUBMITTED: ["ACKNOWLEDGED", "REJECTED"],
        ACKNOWLEDGED: ["RECONCILED", "REJECTED"],
        REJECTED: ["SUBMITTED"],
        RECONCILED: [],
      };
      if (!allowed[previous]?.includes(stage))
        fail(`Cannot record ${stage} after ${previous}`);
      if (last && +when < +new Date(last.occurredAt))
        fail("Evidence dates must follow the recorded payment sequence");
      await tx.payrollPayslip.update({
        where: { id: current.id },
        data: {
          paymentEvidence: {
            encrypted: encryptString(JSON.stringify([...history, event])),
          },
          ...(stage === "RECONCILED"
            ? { paidAt: when, paymentReference: reference.trim() }
            : {}),
        },
      });
      await tx.payrollAuditLog.create({
        data: {
          tenantId,
          payrollRunId: runId,
          payslipId: current.id,
          employeeId: actor.id,
          action: `PAYMENT_${stage}`,
          details: `${employeeCode}: ${stage}; bank reference ${reference.trim()}; evidence ${evidenceRef.trim()}`,
        },
      });
      return { employeeCode, status: stage };
    },
    { tenantId },
  );
}

// Cash pay: HR records that whole payslips were handed over in cash. No bank is involved, so the
// bank evidence sequence does not apply; one RECONCILED event with method CASH settles the payslip.
export async function markPayslipsCashPaid({
  tenantId,
  runId,
  employeeCodes,
  actorCode,
  paidOn,
  receiptNumber,
  requestKey,
}) {
  if (typeof actorCode !== "string" || !actorCode.trim())
    fail("A verified employee code is required to record payment", 403);
  if (!Array.isArray(employeeCodes) || !employeeCodes.length || new Set(employeeCodes).size !== employeeCodes.length)
    fail("Choose at least one payslip, each only once", 400);
  if (!requestKey) fail("A request key is required", 400);
  const when = new Date(paidOn);
  if (!Number.isFinite(+when) || +when > Date.now())
    fail("The paid date must be valid and cannot be in the future", 400);
  const receipt = receiptNumber?.trim() || null;
  return tenantTransaction(
    prisma,
    async (tx) => {
      const actor = await tx.employee.findFirst({
        where: { tenant_id: tenantId, employee_code: actorCode },
      });
      if (!actor)
        fail("A verified employee code is required to record payment", 403);
      const run = await tx.payrollRun.findFirst({
        where: { tenantId, id: runId },
      });
      if (!run) fail("Payroll run not found", 404);
      if (run.status !== "FINALIZED")
        fail("Finalize the approved payroll before recording payments");
      if (!(await runPaysInCash(tx, tenantId, run)))
        fail("This company pays by bank. Record bank evidence instead.");
      const slips = await tx.payrollPayslip.findMany({
        where: {
          tenantId,
          payrollRunId: runId,
          employee: { employee_code: { in: employeeCodes } },
        },
        include: { employee: { select: { employee_code: true } } },
        orderBy: { id: "asc" },
      });
      const missing = employeeCodes.filter(
        (c) => !slips.some((x) => x.employee.employee_code === c),
      );
      if (missing.length)
        fail(`Not in this payroll: ${missing.join(", ")}`, 404);
      await tx.$queryRaw`SELECT id FROM payroll_payslips WHERE "tenantId"=${tenantId}::uuid AND id = ANY(${slips.map((x) => x.id)}::int[]) ORDER BY id FOR UPDATE`;
      const fresh = await tx.payrollPayslip.findMany({
        where: { tenantId, id: { in: slips.map((x) => x.id) } },
        include: { employee: { select: { employee_code: true } } },
        orderBy: { id: "asc" },
      });
      // A retry of the same request is a no-op.
      if (fresh.every((x) => historyOf(x.paymentEvidence).some((e) => e.requestKey === requestKey)))
        return { paid: fresh.length, alreadyRecorded: true };
      const blocked = fresh.filter(
        (x) =>
          x.paidAt ||
          !["FINALIZED", "DISTRIBUTED"].includes(x.status),
      );
      if (blocked.length)
        fail(
          `Already paid or not payable: ${blocked.map((x) => x.employee.employee_code).join(", ")}`,
        );
      for (const slip of fresh) {
        const event = {
          requestKey,
          stage: "RECONCILED",
          method: "CASH",
          reference: receipt || `CASH-${when.toISOString().slice(0, 10)}`,
          receiptNumber: receipt,
          amount: String(slip.netAmount),
          currency: run.currencyCode,
          occurredAt: when.toISOString(),
          actorCode,
        };
        await tx.payrollPayslip.update({
          where: { id: slip.id },
          data: {
            paymentEvidence: {
              encrypted: encryptString(
                JSON.stringify([...historyOf(slip.paymentEvidence), event]),
              ),
            },
            paidAt: when,
            paymentReference: event.reference,
          },
        });
        await tx.payrollAuditLog.create({
          data: {
            tenantId,
            payrollRunId: runId,
            payslipId: slip.id,
            employeeId: actor.id,
            action: "PAYMENT_CASH_PAID",
            details: `${slip.employee.employee_code}: paid in cash on ${when.toISOString().slice(0, 10)}${receipt ? `; receipt ${receipt}` : ""}`,
          },
        });
      }
      return { paid: fresh.length, alreadyRecorded: false };
    },
    { tenantId },
  );
}
