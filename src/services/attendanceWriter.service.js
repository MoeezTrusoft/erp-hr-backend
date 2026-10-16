import { approvedOvertimeCredits } from "../lib/attendanceOvertime.js";
import { syncRuleCases } from './attendanceRuleCases.service.js';
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { isTenantTransaction } from "../lib/rlsTenant.js";
import { replayTenant, dayKey } from "../lib/attendanceReplay.js";
import { dateRange, dateKey, addDays } from "../lib/attendanceDates.js";
import {
  fingerprint,
  jsonValue,
  affectedDays,
} from "../lib/attendanceCapture.js";
import { loadAttendanceRuntime } from "./attendanceSetup.service.js";
import { normalizeWorkMode } from "../lib/attendanceStatus.js";
import {
  attendanceTransaction,
  assertAttendancePeriodOpen,
  lockAttendancePeriod,
} from "./attendancePeriod.service.js";
import {
  loadEvaluationEvidence,
  evidenceHolds,
} from "./attendanceEvidence.service.js";

export const EVALUATION_ALGORITHM = "anomaly-rules-v2";
const numerical = [
  "presenceMinutes",
  "workedMinutes",
  "regularMinutes",
  "unpaidBreakMinutes",
  "paidBreakMinutes",
  "travelMinutes",
  "overtimeMinutes",
  "approvedOvertimeMinutes",
  "payableMinutes",
  "scheduledMinutes",
];
export function computePrimaryProvenance({ primarySn, punchSn }) {
  return primarySn
    ? {
        primary_sn: primarySn,
        secondary_punches: (punchSn || []).filter((s) => s && s !== primarySn)
          .length,
      }
    : {};
}
export function aggregateSessions(sessions) {
  const v = sessions.map((s) => s.verdict),
    states = v.map((s) => s.processingState);
  const processingState = states.includes("AWAITING_DATA")
    ? "AWAITING_DATA"
    : states.includes("NEEDS_REVIEW")
      ? "NEEDS_REVIEW"
      : states.includes("OPEN")
        ? "OPEN"
        : "FINALIZED";
  const sum = Object.fromEntries(
    numerical.map((k) => [k, v.reduce((n, x) => n + (x[k] || 0), 0)]),
  );
  const weight = v.reduce((n, x) => n + (x.scheduledMinutes || 1), 0);
  const dayCredit =
    processingState !== "FINALIZED"
      ? null
      : Number(
          (
            v.reduce(
              (n, x) => n + (x.dayCredit ?? 0) * (x.scheduledMinutes || 1),
              0,
            ) / weight
          ).toFixed(6),
        );
  const severity = [
    "SETUP_REQUIRED",
    "PUNCH_CONFLICT",
    "MISSING_CHECKIN",
    "MISSING_CHECKOUT",
    "PENDING_ATTENDANCE",
    "ABSENT",
    "HALF_DAY",
    "EARLY_CHECKOUT",
    "LATE",
    "PRESENT",
    "ON_LEAVE",
    "HOLIDAY",
    "WEEKLY_OFF",
  ];
  let status =
    severity.find((s) => v.some((x) => x.status === s)) || "SETUP_REQUIRED";
  if (status === "ABSENT" && dayCredit > 0) status = "HALF_DAY";
  const times = (k) =>
    v
      .map((x) => x[k])
      .filter(Boolean)
      .sort((a, b) => a - b);
  return {
    ...sum,
    status,
    dayCredit,
    processingState,
    checkIn: times("checkIn")[0] || null,
    checkOut: times("checkOut").at(-1) || null,
    requiresRegularization:
      processingState === "NEEDS_REVIEW" ||
      v.some((x) => x.requiresRegularization),
    anomalies: v.flatMap((x) => x.anomalies || []),
    issues: v.flatMap((x) => x.issues || []),
  };
}

export async function applyEvaluatedShifts(args) {
  const {
    tenantId,
    from: fromInput,
    to: toInput,
    dryRun = true,
    now = new Date(),
    db = prisma,
    employeeIds,
    trigger = "REPLAY",
    evidenceIds,
  } = args;
  const from = dateKey(fromInput),
    to = dateKey(toInput);
  // Extended Prisma transaction clients may still expose $transaction. Reuse
  // the transaction holding the worker's locks instead of recursively opening it.
  if (!dryRun && db.$transaction && !isTenantTransaction(db))
    return attendanceTransaction(db, tenantId, (tx) =>
      applyEvaluatedShifts({ ...args, db: tx }),
    );
  dateRange(from, to, 370);
  if (!dryRun) {
    // Rule decisions can revise payroll; take the common exclusive lock before
    // any employee lock to avoid shared-to-exclusive upgrades during replay.
    await lockAttendancePeriod(db, tenantId, true);
    if (args.rulesReconciliation) {
      await lockAttendancePeriod(db, tenantId, true);
      if(db.$executeRaw) await db.$executeRaw`SELECT set_config('app.attendance_rules_reconciliation', 'on', true)`;
    } else if (evidenceIds) await lockAttendancePeriod(db, tenantId);
    else await assertAttendancePeriodOpen(db, tenantId, from, to);
  }
  // Acquire in stable order; independent employees may evaluate concurrently.
  const employees = await db.employee.findMany({
    where: {
      tenant_id: tenantId,
      ...(employeeIds ? { id: { in: employeeIds } } : {}),
      NOT: { payroll_included: false },
    },
    select: { id: true, tenant_id: true, work_mode: true },
  });
  if (!dryRun && db.$executeRaw)
    for (const e of [...employees].sort((a, b) => a.id - b.id))
      await db.$executeRaw(
        Prisma.sql(
          ["SELECT pg_advisory_xact_lock(hashtext(", "))"],
          "attendance:" + tenantId + ":" + e.id,
        ),
      );
  const ids = employees.map((e) => e.id),
    bounds = {
      gte: new Date(from + "T00:00:00Z"),
      lte: new Date(to + "T23:59:59.999Z"),
    };
  const [runtime, existingRows, assignments, credits, evidence, overtime] =
    await Promise.all([
      loadAttendanceRuntime({
        tenantId,
        from: addDays(from, -1),
        to: addDays(to, 1),
        db,
      }),
      db.attendance.findMany({
        where: { tenantId, employeeId: { in: ids }, date: bounds },
      }),
      db.shiftAssignment.findMany({
        where: { tenantId, employeeId: { in: ids }, date: bounds },
        orderBy: { id: "desc" },
      }),
      db.attendanceTimeCredit.findMany({
        where: {
          tenantId,
          employeeId: { in: ids },
          date: bounds,
          state: "APPROVED",
        },
      }),
      loadEvaluationEvidence(db, tenantId, from, to, ids),
      db.overtimeRequest.findMany({
        where: {
          tenantId,
          employeeId: { in: ids },
          date: bounds,
          status: "APPROVED",
        },
      }),
    ]);
  const employeeMap = new Map(employees.map((e) => [e.id, e]));
  const assignmentMap = new Map();
  for (const a of assignments) {
    const key = a.employeeId + "|" + dayKey(a.date);
    if (!assignmentMap.has(key)) assignmentMap.set(key, a);
  }
  const shifts = await replayTenant({
    tenantId,
    from,
    to,
    now,
    db,
    employeeIds: ids,
    includeEmpty: true,
    runtime,
    credits: [...credits, ...approvedOvertimeCredits(overtime)],
  });
  const grouped = new Map(),
    existing = new Map(
      existingRows.map((r) => [r.employeeId + "|" + dayKey(r.date), r]),
    );
  for (const s of shifts) {
    const holds = evidenceHolds(s, evidence, now);
    if (holds.length)
      Object.assign(s.verdict, {
        processingState: "AWAITING_DATA",
        dayCredit: null,
        issues: [...(s.verdict.issues || []), ...holds],
      });
    const key = s.employeeId + "|" + dayKey(s.day);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(s);
  }
  const summary = {
    tenantId,
    from,
    to,
    dryRun,
    shifts: shifts.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedManuallyCorrected: 0,
    held: 0,
    corrections: 0,
    retracted: 0,
    nonWorking: 0,
    byStatus: {},
    anomaliesPersisted: 0,
    changes: [],
  };
  for (const [key, sessions] of grouped) {
    const first = sessions[0],
      employeeId = first.employeeId,
      day = first.day,
      old = existing.get(key);
    if (evidenceIds) {
      const touched = [...sessions, ...(old?.calculation?.sessions || [])].some(
        (s) => s.evidence?.some((p) => evidenceIds.includes(p.eventId)),
      );
      if (!touched) continue;
      if (!dryRun) await assertAttendancePeriodOpen(db, tenantId, day, day);
    }
    // Manual times are attributed overlays and are evaluated by the same rules.
    if(!dryRun&&old?.manually_corrected&&old.calculation?.algorithmVersion!==EVALUATION_ALGORITHM) {
      await db.attendanceRuleAudit.create({data:{tenantId,employeeId,action:'LEGACY_MANUAL_PRESERVED',actorId:'attendance-rules',data:jsonValue({before:old})}});
      for(const session of sessions)for(const p of session.evidence.filter(e=>e.legacyManual)) {
        const manual=await db.attendanceManualTime.create({data:{tenantId,employeeId,date:day,sessionKey:session.sessionKey,direction:p.direction,timestamp:new Date(p.at),actorId:p.actorId,reason:p.reason,...(p.enteredAt?{createdAt:new Date(p.enteredAt)}:{})}});
        p.manualId=manual.id;delete p.legacyManual;
      }
    }
    {
      const cases=dryRun
        ? await db.attendanceAnomaly.findMany({where:{tenantId,employeeId,date:day,rulesVersion:2,evidenceState:'ACTIVE'}})
        : await syncRuleCases(db,{tenantId,employeeId,day,sessions,now});
      for(const session of sessions) {
        const own=cases.filter(a=>a.sessionKey===session.sessionKey);
        const facts=session.verdict.anomalies || [];
        const sameFacts=own.length===facts.length && facts.every(f=>own.some(a=>a.type===f.type && Number(a.measuredMinutes)===Number(f.minutes) && +new Date(a.actualTime)===+new Date(f.actualTime) && +new Date(a.expectedTime)===+new Date(f.expectedTime)));
        const blockingIssues=(session.verdict.issues||[]).filter(i=>i.code!=='UNMATCHED_OUT');
        if(session.verdict.processingState==='NEEDS_REVIEW'&&!blockingIssues.length&&sameFacts&&own.length&&own.every(a=>['APPROVED','REJECTED'].includes(a.status))) {
          Object.assign(session.verdict,{processingState:'FINALIZED',dayCredit:1,requiresRegularization:false});
        }
      }
    }
    const verdict = aggregateSessions(sessions);
    summary.byStatus[verdict.status] =
      (summary.byStatus[verdict.status] || 0) + 1;
    if (verdict.dayCredit == null) summary.held++;
    if (["WEEKLY_OFF", "HOLIDAY", "ON_LEAVE"].includes(verdict.status))
      summary.nonWorking++;
    summary.corrections += sessions.reduce(
      (n, s) => n + s.corrections.length,
      0,
    );
    const deadlines = sessions
      .filter((s) => s.verdict.processingState === "OPEN")
      .map((s) => s.deadline)
      .filter(Boolean);
    const nextEvaluationAt =
      verdict.processingState === "AWAITING_DATA"
        ? new Date(+now + 15 * 60000)
        : deadlines.length
          ? new Date(Math.min(...deadlines.map(Number)))
          : null;
    const snapshot = jsonValue({
      algorithmVersion: EVALUATION_ALGORITHM,
      setupVersion: first.setupVersion,
      timeZone: first.setupSnapshot.timeZone,
      policy: first.setupSnapshot.policy,
      verdict,
      sessions,
    });
    const hash = fingerprint(snapshot),
      changed = old?.evaluationHash !== hash;
    if (changed)
      summary.changes.push({
        employeeId,
        employeeCode: employeeMap.get(employeeId)?.employee_code || null,
        date: dayKey(day),
        before: old
          ? {
              status: old.status,
              credit: old.day_credit,
              hours: old.total_hours,
              state: old.processingState,
            }
          : null,
        after: {
          status: verdict.status,
          credit: verdict.dayCredit,
          hours: verdict.workedMinutes / 60,
          state: verdict.processingState,
        },
      });
    const assignment = assignmentMap.get(key);
    const workMode =
      normalizeWorkMode(assignment?.workMode) ||
      normalizeWorkMode(employeeMap.get(employeeId)?.work_mode);
    const data = {
      setupVersion: first.setupVersion ?? null,
      setupSnapshot: jsonValue(first.setupSnapshot),
      status: verdict.status,
      check_in: verdict.checkIn,
      check_out: verdict.checkOut,
      total_hours: verdict.workedMinutes / 60,
      day_credit: verdict.dayCredit,
      requires_regularization: verdict.requiresRegularization,
      processingState: verdict.processingState,
      nextEvaluationAt,
      finalizedAt:
        verdict.processingState === "FINALIZED"
          ? changed
            ? now
            : old?.finalizedAt || now
          : null,
      evaluationHash: hash,
      evaluationVersion: (old?.evaluationVersion || 0) + (changed ? 1 : 0),
      calculation: snapshot,
      ...(workMode ? { work_mode: workMode } : {}),
      ...computePrimaryProvenance({
        primarySn: first.setupSnapshot.primarySn,
        punchSn: sessions.flatMap((s) => s.punchSn),
      }),
      remarks:
        verdict.processingState === "AWAITING_DATA"
          ? "Awaiting capture evidence"
          : verdict.status === "SETUP_REQUIRED"
            ? "Attendance setup required: " + first.setupSnapshot.reason
            : "Evaluated attendance",
    };
    summary[!old ? "created" : changed ? "updated" : "unchanged"]++;
    if (dryRun) continue;
    let row = old;
    if (!old)
      row = await db.attendance.create({
        data: { tenantId, employeeId, date: day, ...data },
      });
    else if (changed)
      row = await db.attendance.update({
        where: {
          id: old.id,
          tenantId,
          updated_at: old.updated_at,
        },
        data,
      });
    if (changed) {
      await db.attendanceSession.deleteMany({
        where: { tenantId, attendanceId: row.id },
      });
      await db.attendanceSession.createMany({
        data: sessions.map((s) => ({
          tenantId,
          attendanceId: row.id,
          sessionKey: s.sessionKey,
          shiftStart: s.shift?.start ?? null,
          shiftEnd: s.shift?.end ?? null,
          processingState: s.verdict.processingState,
          intervals: jsonValue(s.verdict.intervals || []),
          calculation: jsonValue(s),
        })),
      });
      await db.attendanceEvaluation.create({
        data: {
          tenantId,
          attendanceId: row.id,
          version: data.evaluationVersion,
          algorithmVersion: EVALUATION_ALGORITHM,
          inputHash: hash,
          trigger,
          snapshot,
        },
      });
      // Per-shift cases are synchronized above; day-level legacy evidence is retained.
      summary.anomaliesPersisted += verdict.anomalies.length;
    }
    const job = await db.attendanceEvaluationJob.findFirst({
      where: { tenantId, employeeId, date: day },
    });
    const jobData = {
      state: nextEvaluationAt ? "PENDING" : "DONE",
      nextAttemptAt: nextEvaluationAt || now,
      completedAt: nextEvaluationAt ? null : now,
      lastError: null,
      attempts: 0,
    };
    if (job)
      await db.attendanceEvaluationJob.update({
        where: { id: job.id, tenantId },
        data: jobData,
      });
    else
      await db.attendanceEvaluationJob.create({
        data: { tenantId, employeeId, date: day, ...jobData },
      });
  }
  return summary;
}
export async function refreshStaleAttendance({
  tenantId,
  days = 35,
  now = new Date(),
  db = prisma,
}) {
  const to = dayKey(now),
    from = addDays(to, -days);
  return applyEvaluatedShifts({
    tenantId,
    from,
    to,
    dryRun: false,
    now,
    db,
    trigger: "REFRESH",
  });
}
export async function applyEvaluatedShiftsForDays({
  tenantId,
  days,
  employeeIds,
  evidenceIds,
  now = new Date(),
  db = prisma,
}) {
  // Coalesce the three-day neighborhood into one configuration and punch read.
  const dates = affectedDays(days).sort();
  if (!dates.length) return { windows: [] };
  return {
    windows: [
      await applyEvaluatedShifts({
        tenantId,
        from: dates[0],
        to: dates.at(-1),
        employeeIds,
        evidenceIds,
        now,
        db,
        dryRun: false,
        trigger: "CAPTURE",
      }),
    ],
  };
}
