// Has this payroll run's month been submitted through the timesheet gatekeeper?
//
// The gatekeeper writes a TIMESHEET_SUBMITTED audit row linked to the run it
// activates (payrollRunId). That link is the proof. Older rows were written
// without the link; for those only, the audit text must start with the exact
// phrase the gatekeeper wrote ("Timesheet for YYYY-MM submitted"). A bare
// substring match on the month is never enough: "2026-10" also appears in
// unrelated text, and a row mentioning one month must not unlock another.
export const legacySubmissionPrefix = (month) => `Timesheet for ${month} submitted`;

export async function hasTimesheetSubmission(db, { tenantId, run, month, withTenant }) {
  const scoped = (where) => (withTenant ? withTenant(tenantId, where) : { tenantId, ...where });
  const linked = await db.payrollAuditLog.findFirst({
    where: scoped({ action: "TIMESHEET_SUBMITTED", payrollRunId: run.id }),
    select: { id: true },
  });
  if (linked) return true;
  const legacy = await db.payrollAuditLog.findFirst({
    where: scoped({
      action: "TIMESHEET_SUBMITTED",
      payrollRunId: null,
      details: { startsWith: legacySubmissionPrefix(month) },
    }),
    select: { id: true },
  });
  return Boolean(legacy);
}
