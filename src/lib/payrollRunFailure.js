// What to write back to a payroll run when processing throws.
// A tagged precondition error (readiness, attendance setup) means no payslip was calculated, so the
// run goes back to exactly how it was; anything else marks it FAILED. A run that was already stuck in
// PROCESSING has no meaningful "before", so it is marked FAILED too.
export function runUpdateAfterFailure(error, previousRun) {
  const restore = error?.preflight === true && previousRun && previousRun.status !== "PROCESSING";
  return restore ? { ...previousRun } : { status: "FAILED" };
}
