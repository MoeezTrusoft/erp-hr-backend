// Attendance cases nobody raised in time.
//
// A system-detected anomaly (late check-in, missing punch, absence, early check-out) is charged
// unless a resolution request is raised. The employee has two working days on their own roster to
// raise it (computeAnomalyDeadline); HR may raise on their behalf at any time before payroll is
// submitted. Nothing is stored when the window closes: payroll decides from the case's state when it
// is processed, so a raise or a decision made before then always wins.
import { RULE_TYPES } from "../lib/attendanceAnomalyRules.js";
import { computeAnomalyDeadline } from "./attendanceAnomalyRequest.service.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";

const DAY = 86_400_000;
const isCandidate = (a) =>
  a.rulesVersion === 2 &&
  a.status === "PENDING" &&
  a.evidenceState === "ACTIVE" &&
  RULE_TYPES.includes(a.type) &&
  a.raisedById == null;

// Returns the cases with `lapsed` set. Needs raisedById on every case.
export async function markLapsedCases(cases, { tenantId, asOf = new Date(), db } = {}) {
  const open = cases.filter(isCandidate);
  if (!open.length) return cases.map((a) => ({ ...a, lapsed: false }));
  const days = open.map((a) => +new Date(a.date));
  const runtime = await loadAttendanceRuntime({
    tenantId,
    from: new Date(Math.min(...days)),
    to: new Date(Math.max(...days) + 31 * DAY),
    db,
  });
  const lapsed = new Set();
  for (const a of open) {
    const { deadline } = await computeAnomalyDeadline({
      tenantId,
      employeeId: a.employeeId,
      anomalyDate: a.date,
      type: a.type,
      runtime,
    });
    if (+deadline < +asOf) lapsed.add(a);
  }
  return cases.map((a) => ({ ...a, lapsed: lapsed.has(a) }));
}
