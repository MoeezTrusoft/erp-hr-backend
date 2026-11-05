import { scopedWhere } from "./tenancy.js";

// TS-SUBMIT-GATE-02 (2026-09-22) — only RAISED requests count as an open
// question. The evaluator stamps machine-raised anomalies with its own
// sourceKind; those are grading records the employee has not answered yet and
// per the operator's ruling they simply become payroll deductions, not open
// requests HR must resolve. Without the filter a month with 46 un-answered
// evaluator rows read as "46 anomaly requests still awaiting resolution".
//
// One predicate for every gate: the timesheet submit and the payroll
// process/finalize checks must never disagree about what "open" means.
export const PENDING_ANOMALY_STATUSES = ["PENDING"];

export function openRequestWhere(tenantId, { from, to }) {
  return scopedWhere(tenantId, {
    date: { gte: from, lte: to },
    status: { in: PENDING_ANOMALY_STATUSES },
    // A rules-v2 case blocks only once someone raised it: an unraised one is
    // charged at payroll (operator, 2026-10-30), so it is not an open request.
    OR: [
      { sourceKind: "PAPER_FORM" },
      { sourceKind: "RULES_V2", raisedById: { not: null } },
    ],
    evidenceState: "ACTIVE",
  });
}

export function openRequestCount(db, tenantId, { from, to }) {
  return db.attendanceAnomaly.count({ where: openRequestWhere(tenantId, { from, to }) });
}
