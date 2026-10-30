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

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const keyOf = (a) => `${a.employeeId}|${dayOf(a.date)}|${a.type}`;

// Decisions made on the earlier (pre rules-v2) cases of the same employee, day and type. They are not
// carried into the v2 case that re-evaluation opens, so they are applied here: an approved appeal
// excuses the day, a rejected one is charged, a raised one is still held.
async function earlierDecisions(open, { tenantId, db }) {
  if (!db || !open.length) return new Map();
  const days = open.map((a) => +new Date(a.date));
  const rows = await db.attendanceAnomaly.findMany({
    where: {
      tenantId,
      rulesVersion: 1,
      employeeId: { in: [...new Set(open.map((a) => a.employeeId))] },
      date: { gte: new Date(Math.min(...days)), lte: new Date(Math.max(...days)) },
    },
  });
  const out = new Map();
  for (const r of rows) {
    const rank = { APPROVED: 3, REJECTED: 2, PENDING: r.raisedById == null ? 0 : 1 }[r.status] ?? 0;
    // An approved appeal of type OTHER (a paper form, leave or illness explanation) covers the whole day.
    const key = r.type === "OTHER" && r.status === "APPROVED" ? `${r.employeeId}|${dayOf(r.date)}|*` : keyOf(r);
    const have = out.get(key);
    if (!have || rank > have.rank) out.set(key, { rank, status: r.status, raised: r.raisedById != null });
  }
  return out;
}

// Returns the cases with `lapsed` set (charged at payroll) and `decided` set (an earlier decision already
// settled it: approved = excused, rejected = charged). Needs raisedById on every case.
export async function markLapsedCases(cases, { tenantId, asOf = new Date(), db } = {}) {
  const open = cases.filter(isCandidate);
  if (!open.length) return cases.map((a) => ({ ...a, lapsed: false, decided: false }));
  const earlier = await earlierDecisions(open, { tenantId, db });
  const lapsed = new Set();
  const decided = new Set();
  const waiting = [];
  for (const a of open) {
    const before = earlier.get(`${a.employeeId}|${dayOf(a.date)}|*`) ?? earlier.get(keyOf(a));
    if (before?.status === "REJECTED") {
      lapsed.add(a);
      decided.add(a);
    } else if (before?.status === "APPROVED") decided.add(a);
    else if (before?.rank >= 1) continue;
    else waiting.push(a);
  }
  if (waiting.length) {
    const days = waiting.map((a) => +new Date(a.date));
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: new Date(Math.min(...days)),
      to: new Date(Math.max(...days) + 31 * DAY),
      db,
    });
    for (const a of waiting) {
      const { deadline } = await computeAnomalyDeadline({
        tenantId,
        employeeId: a.employeeId,
        anomalyDate: a.date,
        type: a.type,
        runtime,
      });
      if (+deadline < +asOf) lapsed.add(a);
    }
  }
  return cases.map((a) => ({ ...a, lapsed: lapsed.has(a), decided: decided.has(a) }));
}
