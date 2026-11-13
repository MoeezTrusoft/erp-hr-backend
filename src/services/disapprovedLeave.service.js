// src/services/disapprovedLeave.service.js
//
// "Disapproved leave" reaches the deduction engine from TWO independent places:
//
//   1. a LeaveRequest the approver REJECTED — the employee was away without
//      sanction;
//   2. a regularization request (AttendanceAnomaly) the chain REJECTED — the
//      employee tried to explain a bad attendance day and was refused.
//
// The same calendar day can legitimately produce both: someone is refused leave
// for the 14th, is absent anyway, then files a regularization for the 14th and
// is refused again. That is ONE unpaid day, not two. Deducting twice for one
// day is the failure mode this module exists to prevent, so dedup is enforced
// twice over:
//
//   * the generator skips a day that already carries a REJECTED anomaly;
//   * countable occurrences are counted DISTINCT by (employee, day), so even a
//     duplicate row cannot bill twice.
//
// The second guard is the one that matters. The first can be defeated by a race
// between two generator runs; the second cannot.
//
// HR-ATT-POLICY-01.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import logger from "../lib/logger.js";

/** Every calendar day covered by a leave request, inclusive of both ends. */
function eachDay(startDate, endDate) {
  const days = [];
  const cursor = new Date(startDate);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(endDate);
  last.setHours(0, 0, 0, 0);
  // Guard against a reversed or absurd range rather than looping forever.
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || last < cursor) return days;
  let guard = 0;
  while (cursor <= last && guard++ < 400) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * Materialise a DISAPPROVED_LEAVE marker per rejected-leave day.
 *
 * Recorded as an AttendanceAnomaly already in REJECTED state: it is not a
 * request awaiting a decision, it is the record of one that was refused
 * elsewhere. sourceKind/sourceRef carry a unique index, so a re-run is a no-op.
 */
export async function generateDisapprovedLeaveAnomalies({ tenantId, from, to } = {}) {
  const where = { tenantId, status: "REJECTED" };
  if (from || to) {
    where.startDate = {};
    if (from) where.startDate.gte = new Date(from);
    if (to) where.startDate.lte = new Date(to);
  }

  const rejected = await prisma.leaveRequest.findMany({
    where,
    select: { id: true, employeeId: true, startDate: true, endDate: true },
    orderBy: { id: "asc" },
  });

  const summary = { leaveRequests: rejected.length, created: 0, skippedExisting: 0, days: 0 };

  for (const req of rejected) {
    for (const day of eachDay(req.startDate, req.endDate)) {
      summary.days += 1;
      const sourceRef = `leaveRequest:${req.id}:${dayKey(day)}`;

      // Does this employee-day already carry a rejection from EITHER source?
      const clash = await prisma.attendanceAnomaly.findFirst({
        where: { tenantId, employeeId: req.employeeId, date: day, status: "REJECTED" },
        select: { id: true, sourceKind: true, sourceRef: true },
      });
      if (clash) {
        summary.skippedExisting += 1;
        continue;
      }

      try {
        await tenantTransaction(prisma, async (tx) =>
          tx.attendanceAnomaly.create({
            data: {
              tenantId,
              employeeId: req.employeeId,
              type: "ABSENT",
              reason: "Leave request was not approved",
              date: day,
              applicationDate: new Date(),
              status: "REJECTED",
              sourceKind: "LEAVE_REQUEST",
              sourceRef,
              currentApprovalLevel: 1,
            },
          }),
        );
        summary.created += 1;
      } catch (err) {
        // P2002 = the (tenantId, sourceKind, sourceRef) unique index fired, i.e.
        // a concurrent run already wrote this day. That is the index doing its
        // job, not an error worth failing the batch over.
        if (err?.code === "P2002") {
          summary.skippedExisting += 1;
          continue;
        }
        throw err;
      }
    }
  }

  logger.info(summary, "disapproved-leave anomalies generated");
  return summary;
}

/**
 * Countable DISAPPROVED_LEAVE occurrences for a period: one per employee-day,
 * regardless of how many rejected records that day accumulated.
 *
 * This is what the deduction engine consumes. Counting rows instead of days is
 * the bug this function exists to make impossible.
 */
export async function listDisapprovedLeaveDays({ tenantId, from, to }) {
  const rows = await prisma.attendanceAnomaly.findMany({
    where: {
      tenantId,
      status: "REJECTED",
      date: { gte: new Date(from), lte: new Date(to) },
    },
    select: { id: true, employeeId: true, date: true, sourceKind: true, type: true },
    orderBy: [{ employeeId: "asc" }, { date: "asc" }],
  });

  const byDay = new Map();
  for (const row of rows) {
    if (!row.date) continue;
    const key = `${row.employeeId}|${dayKey(row.date)}`;
    if (byDay.has(key)) {
      // Same unpaid day reached us from both sources; keep one, note the other.
      byDay.get(key).sources.push(row.sourceKind ?? "UNKNOWN");
      continue;
    }
    byDay.set(key, {
      employeeId: row.employeeId,
      date: row.date,
      sources: [row.sourceKind ?? "UNKNOWN"],
    });
  }

  return [...byDay.values()];
}
