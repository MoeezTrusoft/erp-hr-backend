// F-01 (audit 2026-11-08) — hard gate on payslip month-on-month swings.
//
// A payslip whose gross moves more than VARIANCE_THRESHOLD_PCT from the same
// employee's previous payslip must carry an audited, written explanation before
// the run can be submitted for approval. This is what would have caught the
// 2.2x gross overpayments (salary total stored as Basic) before approval.
//
// Not flagged, on purpose:
//   - no earlier payslip (new joiner) or an earlier gross of zero (no base);
//   - either payslip carries a prorated base-salary line (joiner / leaver):
//     the swing is the proration, not an error.
// An acknowledgement is bound to the gross it explained: if the payslip is
// recalculated to a different gross, the explanation no longer counts.

export const VARIANCE_THRESHOLD_PCT = 10;
export const VARIANCE_ACK_ACTION = "PAYSLIP_VARIANCE_ACKNOWLEDGED";
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 500;

const num = (v) => Number(v ?? 0);
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
const isProrated = (earnings = []) => earnings.some((e) => /prorated/i.test(String(e.description ?? "")));

/**
 * Payslips of `run` whose gross moved more than the threshold and that no one
 * has explained yet. Returns [{ employeeId, payslipId, previous, current, pct }].
 * Pass `onlyEmployeeId` to test a single employee (used when acknowledging).
 */
export async function unexplainedVariances(db, { tenantId, run, onlyEmployeeId = null, includeAcknowledged = false }) {
  const slips = await db.payrollPayslip.findMany({
    where: { tenantId, payrollRunId: run.id, ...(onlyEmployeeId != null ? { employeeId: onlyEmployeeId } : {}) },
    select: { id: true, employeeId: true, grossAmount: true },
  });
  if (!slips.length) return [];
  const previousRows = await db.payrollPayslip.findMany({
    where: {
      tenantId,
      employeeId: { in: slips.map((s) => s.employeeId) },
      payrollRun: { tenantId, status: { not: "CANCELLED" }, periodStart: { lt: run.periodStart } },
    },
    orderBy: [{ payrollRun: { periodStart: "desc" } }, { id: "desc" }],
    select: { id: true, employeeId: true, grossAmount: true },
  });
  const previous = new Map();
  for (const row of previousRows) if (!previous.has(row.employeeId)) previous.set(row.employeeId, row);

  const flagged = [];
  for (const slip of slips) {
    const before = previous.get(slip.employeeId);
    if (!before) continue;
    const was = num(before.grossAmount),
      now = num(slip.grossAmount);
    if (was <= 0) continue;
    const pct = ((now - was) / was) * 100;
    if (Math.abs(pct) <= VARIANCE_THRESHOLD_PCT) continue;
    flagged.push({ employeeId: slip.employeeId, payslipId: slip.id, previousPayslipId: before.id, previous: was, current: now, pct: Math.round(pct * 10) / 10 });
  }
  if (!flagged.length) return [];

  // A swing that is only proration is expected.
  const earnings = await db.payrollEarning.findMany({
    where: { tenantId, payslipId: { in: flagged.flatMap((f) => [f.payslipId, f.previousPayslipId]) } },
    select: { payslipId: true, description: true },
  });
  const byPayslip = new Map();
  for (const e of earnings) byPayslip.set(e.payslipId, [...(byPayslip.get(e.payslipId) || []), e]);
  const real = flagged.filter((f) => !isProrated(byPayslip.get(f.payslipId)) && !isProrated(byPayslip.get(f.previousPayslipId)));
  if (!real.length || includeAcknowledged) return real;

  const acks = await db.payrollAuditLog.findMany({
    where: { tenantId, action: VARIANCE_ACK_ACTION, payrollRunId: run.id, employeeId: { in: real.map((f) => f.employeeId) } },
    orderBy: { id: "desc" },
    select: { employeeId: true, newValues: true },
  });
  const latest = new Map();
  for (const a of acks) if (!latest.has(a.employeeId)) latest.set(a.employeeId, a);
  return real.filter((f) => !same(latest.get(f.employeeId)?.newValues?.grossAmount ?? NaN, f.current));
}

export const varianceMessage = (list) =>
  `${list.length} payslip(s) moved more than ${VARIANCE_THRESHOLD_PCT}% from last month and need a written explanation before approval ` +
  `(employee ids: ${list.slice(0, 10).map((v) => v.employeeId).join(", ")}${list.length > 10 ? ", …" : ""})`;

/** Normalise and validate the explanation text. */
export function cleanReason(reason) {
  const text = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_REASON_LENGTH) throw Object.assign(new Error(`Explain the change in at least ${MIN_REASON_LENGTH} characters`), { status: 400 });
  if (text.length > MAX_REASON_LENGTH) throw Object.assign(new Error(`Keep the explanation under ${MAX_REASON_LENGTH} characters`), { status: 400 });
  return text;
}
