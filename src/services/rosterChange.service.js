// src/services/rosterChange.service.js
//
// Changing a roster, safely (HR-ROSTER-02).
//
// Rosters used to be changed by rewriting schedule_pattern in place. Since
// HR-ROSTER-01 resolves the roster PER DAY, an in-place edit now reaches
// backwards over every day the row ever covered: correcting somebody's weekend
// in September silently re-derives August, turning reconciled attendance into
// absences and absences into pay. A month that has been closed must stay
// closed.
//
// So a change FROM a date closes the version covering that date on the day
// before, and opens a new one on it. Ranges stay contiguous and non-overlapping,
// which is what lets "the schedule in force on this day" be a single row.
//
// One exception, and it is not a special case so much as the same rule applied
// honestly: if the change starts on the very day the current version starts,
// closing it would leave a version covering nothing. The stored value was wrong
// for that row's entire life — a correction, not a change — so the row is
// updated and what it held is preserved under `supersedes`.
import prisma from "../lib/prisma.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { assertSchedulePattern } from "../lib/schedulePattern.js";
import logger from "../lib/logger.js";

const DAY_MS = 86_400_000;

const startOfDay = (v) => {
  const d = new Date(v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/**
 * Move an employee onto a new roster from a date.
 *
 * @param {object}  args
 * @param {number}  args.employeeId
 * @param {string}  args.tenantId
 * @param {string|Date} args.effectiveFrom  first day the new pattern applies
 * @param {object}  args.pattern            the new schedule_pattern
 * @param {string}  args.reason             why — stored on the version
 * @param {string} [args.changedBy]
 * @param {boolean} [args.dryRun]           report the plan, write nothing
 * @returns {Promise<{action: string, closed: ?number, created: ?number}>}
 */
export async function changeRoster({
  employeeId, tenantId, effectiveFrom, pattern, reason, changedBy = null, dryRun = false,
}) {
  // HR-ROSTER-03 — refuse a pattern nothing can read. Every consumer degrades
  // silently on a bad one (offDays [8] means never off; a malformed shift
  // leaves the day with no window), so the write boundary is the last place a
  // wrong roster is still cheap.
  assertSchedulePattern(pattern);

  const from = startOfDay(effectiveFrom);

  const existing = await prisma.workSchedule.findMany({
    where: { employeeId },
    orderBy: { effective_start_date: "desc" },
    select: {
      id: true, schedule_pattern: true,
      effective_start_date: true, effective_end_date: true,
    },
  });

  // Backdating before everything on file would leave days governed by a roster
  // that never existed. Refuse rather than invent history.
  const earliest = existing.length
    ? startOfDay(existing[existing.length - 1].effective_start_date)
    : null;
  if (earliest && from < earliest) {
    throw new Error(
      `roster change effective ${from.toISOString().slice(0, 10)} is before the earliest `
      + `version on file (${earliest.toISOString().slice(0, 10)})`,
    );
  }

  const covering = existing.find(
    (s) => startOfDay(s.effective_start_date) <= from
      && (s.effective_end_date == null || startOfDay(s.effective_end_date) >= from),
  );

  const stamped = { ...pattern, changeReason: reason, changedBy };

  // Correction: the version starts on the same day, so it covered nothing else.
  if (covering && startOfDay(covering.effective_start_date).getTime() === from.getTime()) {
    const data = {
      schedule_pattern: { ...stamped, supersedes: covering.schedule_pattern ?? null },
    };
    if (!dryRun) {
      await tenantTransaction(prisma, async (tx) => {
        await tx.workSchedule.update({ where: { id: covering.id }, data });
      });
    }
    logger.warn(
      { employeeId, effectiveFrom: from, reason, dryRun },
      "roster corrected in place (version started on the same day)",
    );
    return { action: "corrected", closed: null, created: covering.id };
  }

  let created = null;
  if (!dryRun) {
    await tenantTransaction(prisma, async (tx) => {
      if (covering) {
        await tx.workSchedule.update({
          where: { id: covering.id },
          data: { effective_end_date: new Date(from.getTime() - DAY_MS) },
        });
      }
      const row = await tx.workSchedule.create({
        data: {
          employeeId,
          tenantId,
          schedule_pattern: stamped,
          effective_start_date: from,
          effective_end_date: null,
        },
      });
      created = row?.id ?? null;
    });
  }

  logger.warn(
    { employeeId, effectiveFrom: from, closed: covering?.id ?? null, reason, dryRun },
    "roster version added",
  );
  return { action: covering ? "versioned" : "created", closed: covering?.id ?? null, created };
}
