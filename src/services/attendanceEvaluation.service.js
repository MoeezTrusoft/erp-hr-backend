import {legacyDecision} from './approval/legacy.js';
import {requireApproval} from './approval/adapters.js';
import prisma from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import {
  dateRange,
  dateOnly,
  dateKey,
  addDays,
} from "../lib/attendanceDates.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";
import { markLapsedCases } from "./attendanceLapse.service.js";
import { RULE_TYPES } from "../lib/attendanceAnomalyRules.js";
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

// §368 — an unresolved capture event can hold a month open only while it can
// still belong to that month.
const CAPTURE_OPEN_STATES = ["PENDING", "FAILED", "NEEDS_REVIEW"];

export async function attendanceCompleteness(
  { tenantId, from, to, employeeIds, asOf = new Date() },
  db = prisma,
) {
  const days = dateRange(from, to, 370);
  // Punches for a month are received around it (a little before for late
  // sweeps, a few days after for night shifts and device retries). Anything
  // unresolved and older/newer than this band is stale for this month.
  const captureScanFrom = new Date(+dateOnly(from) - 30 * 86400000);
  const captureScanTo = new Date(+dateOnly(to) + 8 * 86400000);
  const [
    employees,
    runtime,
    rows,
    events,
    unresolvedCaptureTotal,
    olderEvents,
    jobs,
    corrections,
    ruleCases,
  ] = await Promise.all(
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
      // §368 (operator, 2026-11-04) — the gate only looks at the month, and the
      // scan is bounded to it. It used to load every unresolved capture event in
      // the tenant's history and count a dateless one as an issue, so a single
      // stale device record kept ready=false for EVERY month, forever. Unresolved
      // evidence outside the month (or with no punch date) is reported as
      // `staleEvents` instead and can be dismissed.
      db.attendanceCaptureEvent.findMany({
        where: {
          tenantId,
          state: { in: CAPTURE_OPEN_STATES },
          createdAt: { gte: captureScanFrom, lte: captureScanTo },
        },
        select: { id: true, employeeId: true, parsed: true, state: true, createdAt: true },
      }),
      // The stale side needs the total, and a sample of the evidence old enough
      // to predate the scan (the most common junk: a punch with no parseable
      // date, or one whose employee never matched).
      db.attendanceCaptureEvent.count({
        where: { tenantId, state: { in: CAPTURE_OPEN_STATES } },
      }),
      db.attendanceCaptureEvent.findMany({
        where: {
          tenantId,
          state: { in: CAPTURE_OPEN_STATES },
          createdAt: { lt: captureScanFrom },
        },
        select: { id: true, employeeId: true, parsed: true, state: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 25,
      }),
      db.attendanceEvaluationJob.findMany({
        where: {
          tenantId,
          state: { in: ["PENDING", "FAILED"] },
          date: { gte: dateOnly(from), lte: dateOnly(to) },
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        },
      }),
      db.attendanceCorrectionRequest.findMany({
        where: { tenantId, status: "PENDING", date: { gte: dateOnly(from), lte: dateOnly(to) }, ...(employeeIds ? { employeeId: { in: employeeIds } } : {}) },
        select: { id: true, employeeId: true, date: true },
      }),
      db.attendanceAnomaly.findMany({
        where: {
          tenantId,
          rulesVersion: 2,
          evidenceState: "ACTIVE",
          date: { gte: dateOnly(from), lte: dateOnly(to) },
          ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        },
        select: { id: true, employeeId: true, date: true, type: true, status: true, raisedById: true, rulesVersion: true, evidenceState: true },
      }),
    ],
  );
  // A day held only by rules-v2 cases settles once each case is decided, or was never raised and its
  // two working days are over (it is then charged at payroll, not held). A raised case still waiting
  // for a decision, or an unraised one still inside its window, keeps the day open.
  const marked = await markLapsedCases(ruleCases.filter((c) => RULE_TYPES.includes(c.type)), { tenantId, asOf, db });
  const casesByDay = new Map();
  for (const c of marked) {
    const k = c.employeeId + "|" + dateKey(c.date);
    const day = casesByDay.get(k) ?? { any: false, held: false };
    day.any = true;
    if (c.status === "PENDING" && !c.decided && (c.raisedById != null || !c.lapsed)) day.held = true;
    casesByDay.set(k, day);
  }
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
          employeeCode: employee.employee_code,
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
      const ruleDay = casesByDay.get(employee.id + "|" + date);
      const settledByCases = row.processingState === "NEEDS_REVIEW" && !["PUNCH_CONFLICT", "SETUP_REQUIRED"].includes(row.status)
        && row.calculation?.algorithmVersion === EVALUATION_ALGORITHM && ruleDay?.any === true && !ruleDay.held;
      const settled = (row.processingState === "FINALIZED" && row.day_credit != null && row.calculation?.algorithmVersion === EVALUATION_ALGORITHM) || settledByCases;
      entry.settled = Boolean(settled);
      if (!settled) {
        totals.unsettledDays++;
        issues.push({ ...entry, code: "ATTENDANCE_" + entry.state });
      } else if (info.working) totals.finalizedDays++;
    }
  // §368 — only evidence that can still belong to THIS month holds it open. An
  // event with no punch date, a punch date outside the window, or an employee
  // who is not part of this period is stale: reported separately, never a
  // blocker (a dateless record used to block every month forever).
  const stale = [];
  const staleOf = (e, reason) =>
    stale.push({
      id: e.id,
      state: e.state,
      employeeId: e.employeeId,
      employeeCode: null,
      date: e.parsed?.punchedAt?.slice(0, 10) ?? null,
      reason,
    });
  for (const e of events) {
    const day = e.parsed?.punchedAt?.slice(0, 10);
    const at = day ? +new Date(e.parsed.punchedAt) : NaN;
    // An unattributed but DATED punch still blocks: it may belong to anyone in
    // the period (UNKNOWN_IDENTITY evidence is recovered once an enrolment
    // exists). Only an employee outside this period makes it stale.
    const relevant = e.employeeId == null || relevantEmployees.has(e.employeeId);
    if (day && Number.isFinite(at) && at >= +dateOnly(from) && at < captureThrough && relevant)
      issues.push({
        code: "CAPTURE_" + e.state,
        employeeId: e.employeeId,
        eventId: e.id,
        date: day,
      });
    else
      staleOf(
        e,
        !day || !Number.isFinite(at)
          ? "NO_PUNCH_DATE"
          : relevant
            ? "OUTSIDE_PERIOD"
            : "NOT_IN_PERIOD",
      );
  }
  for (const e of olderEvents)
    if (!stale.some((s) => s.id === e.id)) staleOf(e, "OLDER_THAN_PERIOD");
  // The total is exact even when the sample above is not exhaustive.
  const staleCount = Math.max(0, unresolvedCaptureTotal - issues.filter((i) => i.eventId).length);
  for (const job of jobs)
    if (relevantEmployees.has(job.employeeId))
      issues.push({
        code: "EVALUATION_" + job.state,
        employeeId: job.employeeId,
        date: dateKey(job.date),
        jobId: job.id,
      });
  const codes = new Map(employees.map(e => [e.id, e.employee_code]));
  if (corrections.length) {
    const approvals = await db.hrApprovalRequest.findMany({where:{tenantId,kind:"ATTENDANCE_CORRECTION",sourceRef:{in:corrections.map(c=>c.id)}}});
    for (const correction of corrections) {
      const approval=approvals.find(a=>a.sourceRef===correction.id);
      // A saved draft has not been submitted and cannot hold payroll indefinitely.
      if (!approval || ["WITHDRAWN", "REJECTED"].includes(approval.stage)) continue;
      issues.push({code:"CORRECTION_AWAITING_"+approval.stage,employeeId:correction.employeeId,date:dateKey(correction.date),requestRef:correction.id,approvalRef:approval.id});
    }
  }
  const staleItems = stale.slice(0, 25).map((s) => ({
    ...s,
    employeeCode: codes.get(s.employeeId) || null,
  }));
  return {
    from,
    to,
    ready: issues.length === 0,
    totals,
    issues: issues.map(issue => ({ ...issue, employeeCode: codes.get(issue.employeeId) || null })),
    staleEvents: { count: staleCount, items: staleItems },
    coverage,
  };
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
  if (!row) {
    const runtime=await loadAttendanceRuntime({tenantId,from:date,to:date,db});
    const plan=runtime.resolve(employeeId,date);
    return {attendance:{processingState:plan.working==null?'SETUP_REQUIRED':'AWAITING_EVALUATION',status:plan.reason || 'PENDING_ATTENDANCE',calculation:null,setupSnapshot:plan},history:[],credits:[],punches:[],planned:true};
  }
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
export const saveAttendanceTimeCredit=(input,db=prisma)=>writeTimeCredit(input,db);
async function writeTimeCredit(
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
  approvedRef = null,
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
    if(approvedRef)await requireApproval(tx,tenantId,"TIME_CREDIT",approvedRef);
    const data={
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
        approvedBy: approvedRef?String(actorId):"",
        state: approvedRef?"APPROVED":"PENDING",
    };
    const credit=approvedRef?await tx.attendanceTimeCredit.update({where:{id:approvedRef},data}):await tx.attendanceTimeCredit.create({data});
    if(!approvedRef)return credit;
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
export const revokeAttendanceTimeCredit=({id})=>legacyDecision("TIME_CREDIT_REVOCATION",id);
export async function finalizeTimeCredit(tx,env,row,approved){
 if(!approved)return tx.attendanceTimeCredit.update({where:{id:row.id},data:{state:"REJECTED"}});
 return writeTimeCredit({...row,date:dateKey(row.date),actorId:env.who.employee_code,actorEmployeeId:env.who.id},tx,row.id);
}
export async function finalizeTimeCreditRevocation(
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
    await requireApproval(tx,tenantId,"TIME_CREDIT_REVOCATION",id);
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
