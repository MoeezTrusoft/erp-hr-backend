import prisma from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import {
  dateRange,
  dateOnly,
  dateKey,
  addDays,
} from "../lib/attendanceDates.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";
import {
  attendanceTransaction,
  assertAttendancePeriodOpen,
  lockAttendancePeriod,
} from "./attendancePeriod.service.js";
import {
  applyEvaluatedShifts,
  applyEvaluatedShiftsForDays,
  EVALUATION_ALGORITHM,
} from "./attendanceWriter.service.js";
import { captureAudit } from "./attendanceCapture.service.js";
import { jsonValue } from "../lib/attendanceCapture.js";

export async function attendanceCompleteness(
  { tenantId, from, to, employeeIds },
  db = prisma,
) {
  const days = dateRange(from, to, 370);
  const [employees, runtime, rows, events, decisions, jobs] = await Promise.all(
    [
      db.employee.findMany({
        where: {
          tenant_id: tenantId,
          ...(employeeIds ? { id: { in: employeeIds } } : {}),
          NOT: { payroll_included: false },
        },
        select: {
          id: true,
          employee_name: true,
          employee_code: true,
          attendanceInputMode: true,
        },
      }),
      loadAttendanceRuntime({ tenantId, from, to, db }),
      db.attendance.findMany({
        where: {
          tenantId,
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
          date: { gte: dateOnly(from), lte: dateOnly(to) },
        },
      }),
      db.attendanceCaptureEvent.findMany({
        where: {
          tenantId,
          state: { in: ["PENDING", "FAILED", "NEEDS_REVIEW"] },
        },
        select: { id: true, employeeId: true, parsed: true, state: true },
      }),
      db.attendanceAnomaly.findMany({
        where: {
          tenantId,
          date: { gte: dateOnly(from), lte: dateOnly(to) },
          sourceKind: { in: ["REGULARIZATION", "PAPER_FORM"] },
          status: { in: ["APPROVED", "REJECTED"] },
        },
      }),
      db.attendanceEvaluationJob.findMany({
        where: {
          tenantId,
          state: { in: ["PENDING", "FAILED"] },
          date: { gte: dateOnly(from), lte: dateOnly(to) },
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        },
      }),
    ],
  );
  const byDay = new Map(
    rows.map((r) => [r.employeeId + "|" + dateKey(r.date), r]),
  );
  const issues = [],
    coverage = [],
    totals = {
      expectedDays: 0,
      finalizedDays: 0,
      missingDays: 0,
      unsettledDays: 0,
      setupIssues: 0,
    };
  let captureThrough = +dateOnly(to) + 86400000;
  const relevantEmployees = new Set();
  for (const employee of employees)
    for (const date of days) {
      const info = runtime.resolve(employee.id, date);
      if (["NOT_ELIGIBLE", "MANUAL_MONTHLY"].includes(info.reason)) continue;
      relevantEmployees.add(employee.id);
      if (date === dateKey(to) && info.shift?.end)
        captureThrough = Math.max(
          captureThrough,
          +info.shift.end + (info.policy?.checkoutLeniencyMin ?? 240) * 60000,
        );
      // A published automatic mode is authoritative; an unpublished manual mode is still a setup issue.
      const row = byDay.get(employee.id + "|" + date),
        entry = {
          employeeId: employee.id,
          date,
          working: info.working,
          state: row?.processingState || "MISSING",
          siteIds: info.siteAssignment?.siteIds || [],
          attendanceId: row?.id,
        };
      coverage.push(entry);
      if (info.working) totals.expectedDays++;
      if (info.working == null) {
        totals.setupIssues++;
        issues.push({ ...entry, code: info.reason });
        continue;
      }
      if (!row) {
        totals.missingDays++;
        issues.push({ ...entry, code: "MISSING_ATTENDANCE_ROW" });
        continue;
      }
      const humanFinal =
        row.manually_corrected &&
        row.day_credit != null &&
        !row.requires_regularization;
      // A final human request decision already determines the published payroll
      // treatment of missing punches. It cannot waive a site, clock or capture hold.
      const dayDecisions = decisions.filter(
        (d) => d.employeeId === employee.id && dateKey(d.date) === date,
      );
      const missingOnly =
        ["MISSING_CHECKIN", "MISSING_CHECKOUT"].includes(row.status) &&
        (row.calculation?.verdict?.issues || []).every(
          (i) => i.code === "UNMATCHED_OUT",
        );
      const reviewed =
        (missingOnly && dayDecisions.length > 0) ||
        (row.manually_corrected &&
          dayDecisions.some((d) => d.status === "APPROVED"));
      const settled =
        humanFinal ||
        reviewed ||
        (row.processingState === "FINALIZED" &&
          row.day_credit != null &&
          row.calculation?.algorithmVersion === EVALUATION_ALGORITHM);
      entry.settled = Boolean(settled);
      if (reviewed) {
        entry.state = "REVIEWED";
        entry.decisionIds = dayDecisions.map((d) => d.id);
      }
      if (!settled) {
        totals.unsettledDays++;
        issues.push({ ...entry, code: "ATTENDANCE_" + entry.state });
      } else if (info.working) totals.finalizedDays++;
    }
  for (const e of events) {
    const day = e.parsed?.punchedAt?.slice(0, 10);
    if (
      (e.employeeId == null || relevantEmployees.has(e.employeeId)) &&
      (!day ||
        (+new Date(e.parsed.punchedAt) >= +dateOnly(from) &&
          +new Date(e.parsed.punchedAt) < captureThrough))
    )
      issues.push({
        code: "CAPTURE_" + e.state,
        employeeId: e.employeeId,
        eventId: e.id,
        date: day,
      });
  }
  for (const job of jobs)
    if (relevantEmployees.has(job.employeeId))
      issues.push({
        code: "EVALUATION_" + job.state,
        employeeId: job.employeeId,
        date: dateKey(job.date),
        jobId: job.id,
      });
  return { from, to, ready: issues.length === 0, totals, issues, coverage };
}
export async function assertAttendanceComplete(args, db = prisma) {
  const result = await attendanceCompleteness(args, db);
  if (!result.ready)
    throw Object.assign(
      new Error(
        "Attendance is incomplete: " +
          result.issues.length +
          " unresolved calculation or capture issue(s). Resolve them before submitting payroll.",
      ),
      { status: 409, issues: result.issues },
    );
  return result;
}
export async function explainAttendance(
  { tenantId, employeeId, date },
  db = prisma,
) {
  const row = await db.attendance.findFirst({
    where: { tenantId, employeeId, date: dateOnly(date) },
  });
  if (!row)
    throw Object.assign(
      new Error("Attendance has not been evaluated for this date"),
      { status: 404 },
    );
  const [history, credits, punches] = await Promise.all([
    db.attendanceEvaluation.findMany({
      where: { tenantId, attendanceId: row.id },
      orderBy: { version: "desc" },
      take: 20,
    }),
    db.attendanceTimeCredit.findMany({
      where: { tenantId, employeeId, date: dateOnly(date) },
      orderBy: { createdAt: "desc" },
    }),
    db.attendanceDevicePunch.findMany({
      where: {
        tenantId,
        employeeId,
        punchedAt: { gte: dateOnly(date), lt: addDays(date, 2) },
      },
      select: {
        id: true,
        punchedAt: true,
        status: true,
        sn: true,
        excludedAt: true,
        excludedBy: true,
        exclusionReason: true,
        exclusionVersion: true,
      },
    }),
  ]);
  return { attendance: row, history, credits, punches };
}
export async function reviewAttendancePunch(
  { tenantId, id, version, exclude, reason, actorId, actorEmployeeId },
  db = prisma,
) {
  if (!reason?.trim() || !actorId || !actorEmployeeId)
    throw Object.assign(
      new Error("An identified HR reviewer and reason are required"),
      { status: 400 },
    );
  return attendanceTransaction(db, tenantId, async (tx) => {
    const punch = await tx.attendanceDevicePunch.findFirst({
      where: { tenantId, id, exclusionVersion: version },
    });
    if (!punch?.employeeId)
      throw Object.assign(
        new Error("Punch changed or has no resolved employee"),
        { status: 409 },
      );
    if (punch.employeeId === Number(actorEmployeeId))
      throw Object.assign(
        new Error("Another HR reviewer must review your punches"),
        { status: 403 },
      );
    await lockAttendancePeriod(tx, tenantId);
    if (tx.$executeRaw)
      await tx.$executeRaw(
        Prisma.sql(
          ["SELECT pg_advisory_xact_lock(hashtext(", "))"],
          "attendance:" + tenantId + ":" + punch.employeeId,
        ),
      );
    const changed = await tx.attendanceDevicePunch.updateMany({
      where: { tenantId, id, exclusionVersion: version },
      data: {
        excludedAt: exclude ? new Date() : null,
        excludedBy: String(actorId),
        exclusionReason: reason.trim(),
        exclusionVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1)
      throw Object.assign(new Error("Punch changed; reload the calculation"), {
        status: 409,
      });
    await captureAudit(tx, {
      tenantId,
      eventId: punch.captureEventId,
      actorId,
      action: exclude ? "PUNCH_EXCLUDED" : "PUNCH_RESTORED",
      reason,
      detail: {
        punchId: id,
        previousExcludedAt: punch.excludedAt,
        employeeId: punch.employeeId,
      },
    });
    await applyEvaluatedShiftsForDays({
      tenantId,
      days: [punch.punchedAt],
      evidenceIds: [punch.captureEventId || "legacy:" + punch.id],
      employeeIds: [punch.employeeId],
      db: tx,
    });
    return { id, excluded: exclude };
  });
}
export async function saveAttendanceTimeCredit(
  {
    tenantId,
    employeeId,
    date,
    kind,
    start,
    end,
    fromSiteId,
    toSiteId,
    paid = false,
    reason,
    actorId,
    actorEmployeeId,
  },
  db = prisma,
) {
  if (kind === "OVERTIME")
    throw Object.assign(
      new Error("Use the existing overtime request and approval workflow"),
      { status: 409 },
    );
  if (
    !["TRAVEL", "OVERTIME"].includes(kind) ||
    !reason?.trim() ||
    !actorId ||
    !actorEmployeeId
  )
    throw Object.assign(
      new Error(
        "A time-credit kind, reason and identified HR approver are required",
      ),
      { status: 400 },
    );
  if (Number(actorEmployeeId) === Number(employeeId))
    throw Object.assign(
      new Error("An employee cannot approve their own time credit"),
      { status: 403 },
    );
  const day = dateOnly(date);
  let a = new Date(start),
    b = new Date(end);
  if (
    !Number.isFinite(+a) ||
    !Number.isFinite(+b) ||
    b <= a ||
    a < day ||
    b > new Date(+day + 48 * 3600000)
  )
    throw Object.assign(
      new Error(
        "Use an ordered time window within the work date and following day",
      ),
      { status: 400 },
    );
  return attendanceTransaction(db, tenantId, async (tx) => {
    await assertAttendancePeriodOpen(tx, tenantId, date, date);
    if (tx.$executeRaw)
      await tx.$executeRaw(
        Prisma.sql(
          ["SELECT pg_advisory_xact_lock(hashtext(", "))"],
          "attendance:" + tenantId + ":" + employeeId,
        ),
      );
    const employee = await tx.employee.findFirst({
      where: { tenant_id: tenantId, id: employeeId },
    });
    if (!employee)
      throw Object.assign(new Error("Employee not found"), { status: 404 });
    const runtime = await loadAttendanceRuntime({
      tenantId,
      from: date,
      to: date,
      db: tx,
    });
    const info = runtime.resolve(employeeId, date);
    if (
      kind === "TRAVEL" &&
      (!info.sites?.some((s) => s.id === fromSiteId) ||
        !info.sites?.some((s) => s.id === toSiteId) ||
        fromSiteId === toSiteId)
    )
      throw Object.assign(
        new Error("Choose distinct published departure and arrival sites"),
        { status: 400 },
      );
    if (kind === "TRAVEL") {
      const punches = await tx.attendanceDevicePunch.findMany({
        where: {
          tenantId,
          employeeId,
          excludedAt: null,
          punchedAt: { gte: new Date(+a - 60000), lte: new Date(+b + 60000) },
        },
      });
      const site = (p) =>
        p.siteId || info.deviceSites?.find((d) => d.sn === p.sn)?.siteId;
      const departure = punches.find(
        (p) =>
          [1, 5].includes(p.status) &&
          site(p) === fromSiteId &&
          Math.abs(+p.punchedAt - +a) < 60000,
      );
      const arrival = punches.find(
        (p) =>
          [0, 4].includes(p.status) &&
          site(p) === toSiteId &&
          Math.abs(+p.punchedAt - +b) < 60000,
      );
      if (!departure || !arrival || arrival.punchedAt <= departure.punchedAt)
        throw Object.assign(
          new Error(
            "Travel approval requires a recorded OUT at departure and IN at arrival",
          ),
          { status: 409 },
        );
      a = departure.punchedAt;
      b = arrival.punchedAt;
      const route = info.siteRoutes?.find(
        (r) => r.fromSiteId === fromSiteId && r.toSiteId === toSiteId,
      );
      if (route && (+b - +a) / 60000 < route.minimumMinutes)
        throw Object.assign(
          new Error(
            "Travel is faster than the published minimum; investigate the evidence",
          ),
          { status: 409 },
        );
    }
    const overlap = await tx.attendanceTimeCredit.findFirst({
      where: {
        tenantId,
        employeeId,
        date: day,
        state: "APPROVED",
        start: { lt: b },
        end: { gt: a },
      },
    });
    if (overlap)
      throw Object.assign(
        new Error("An approved credit already covers this interval"),
        { status: 409 },
      );
    const credit = await tx.attendanceTimeCredit.create({
      data: {
        tenantId,
        employeeId,
        date: day,
        kind,
        start: a,
        end: b,
        fromSiteId: fromSiteId || null,
        toSiteId: toSiteId || null,
        paid,
        reason: reason.trim(),
        approvedBy: String(actorId),
        state: "APPROVED",
      },
    });
    await applyEvaluatedShifts({
      tenantId,
      from: date,
      to: date,
      employeeIds: [employeeId],
      db: tx,
      dryRun: false,
      trigger: "TIME_CREDIT",
    });
    return credit;
  });
}
export async function revokeAttendanceTimeCredit(
  { tenantId, id, reason, actorId },
  db = prisma,
) {
  if (!reason?.trim() || !actorId)
    throw Object.assign(new Error("A reason and actor are required"), {
      status: 400,
    });
  return attendanceTransaction(db, tenantId, async (tx) => {
    const credit = await tx.attendanceTimeCredit.findFirst({
      where: { tenantId, id, state: "APPROVED" },
    });
    if (!credit)
      throw Object.assign(new Error("Active time credit not found"), {
        status: 404,
      });
    const date = dateKey(credit.date);
    await assertAttendancePeriodOpen(tx, tenantId, date, date);
    if (tx.$executeRaw)
      await tx.$executeRaw(
        Prisma.sql(
          ["SELECT pg_advisory_xact_lock(hashtext(", "))"],
          "attendance:" + tenantId + ":" + credit.employeeId,
        ),
      );
    const result = await tx.attendanceTimeCredit.update({
      where: { id, tenantId, state: "APPROVED" },
      data: {
        state: "REVOKED",
        revokedBy: String(actorId),
        revokedReason: reason.trim(),
      },
    });
    await applyEvaluatedShifts({
      tenantId,
      from: date,
      to: date,
      employeeIds: [credit.employeeId],
      db: tx,
      dryRun: false,
      trigger: "CREDIT_REVOKED",
    });
    return result;
  });
}
export async function evaluationOverview({ tenantId, from, to }, db = prisma) {
  const [completeness, jobs, events] = await Promise.all([
    attendanceCompleteness({ tenantId, from, to }, db),
    db.attendanceEvaluationJob.findMany({
      where: { tenantId, date: { gte: dateOnly(from), lte: dateOnly(to) } },
    }),
    db.attendanceCaptureEvent.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: dateOnly(from),
          lte: new Date(+dateOnly(to) + 86399999),
        },
      },
      select: { createdAt: true, processedAt: true, state: true, sn: true },
    }),
  ]);
  const bySite = {};
  for (const row of completeness.coverage)
    for (const site of row.siteIds.length ? row.siteIds : ["UNASSIGNED"]) {
      bySite[site] ||= { expected: 0, finalized: 0, unsettled: 0 };
      if (row.working) {
        bySite[site].expected++;
        bySite[site][row.settled ? "finalized" : "unsettled"]++;
      }
    }
  const latencies = events
    .filter((e) => e.processedAt)
    .map((e) => Math.max(0, +e.processedAt - +e.createdAt))
    .sort((a, b) => a - b);
  return jsonValue({
    ...completeness,
    bySite,
    jobs: {
      pending: jobs.filter((j) => j.state === "PENDING").length,
      failed: jobs.filter((j) => j.state === "FAILED").length,
      protected: jobs.filter((j) => j.state === "PROTECTED").length,
      oldestDueAt:
        jobs
          .filter((j) => ["PENDING", "FAILED"].includes(j.state))
          .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0]
          ?.nextAttemptAt || null,
    },
    latency: {
      samples: latencies.length,
      p95Ms: latencies.length
        ? latencies[Math.ceil(latencies.length * 0.95) - 1]
        : null,
    },
  });
}
