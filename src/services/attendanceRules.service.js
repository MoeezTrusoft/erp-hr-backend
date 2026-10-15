import { legacyDecision } from './approval/legacy.js';
import { requireApproval } from './approval/adapters.js';
import prisma from "../lib/prisma.js";
import {
  dateKey,
  dateOnly,
  addDays,
  dateRange,
} from "../lib/attendanceDates.js";
import { civilNow } from "../lib/attendanceClock.js";
import {
  isManagement,
  isAttendanceHr,
  ruleDeductions,
} from "../lib/attendanceAnomalyRules.js";
import {
  attendanceTransaction,
  lockAttendancePeriod,
  assertAttendancePeriodOpen,
} from "./attendancePeriod.service.js";
import { replayTenant } from "../lib/attendanceReplay.js";
import { applyEvaluatedShifts } from "./attendanceWriter.service.js";
import {
  reconcileRulePayroll,
  LEGACY_ATTENDANCE_CODES,
} from "./attendanceRulePayroll.service.js";
import * as money from "../lib/money.js";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const json = (v) => JSON.parse(JSON.stringify(v));
const actor = (user) =>
  String(
    user.userId ||
      user.id ||
      user.employeeId ||
      fail(403, "An identified user is required"),
  );
const requireHr = (user) => {
  if (!isAttendanceHr(user)) fail(403, "An HR role is required");
};
const requireManagement = (user) => {
  if (!isManagement(user))
    fail(403, "Only the Management role may decide attendance anomalies");
};
async function employeeScope(db, user, employeeId) {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, tenant_id: user.tenantId },
  });
  if (!employee) fail(404, "Employee not found");
  if (
    !isAttendanceHr(user) &&
    employeeId !== Number(user.employeeId) &&
    employee.managerId !== Number(user.employeeId)
  )
    fail(403, "This attendance record is outside your scope");
  return employee;
}
async function audit(db, user, action, data, employeeId, anomalyId) {
  return db.attendanceRuleAudit.create({
    data: {
      tenantId: user.tenantId,
      employeeId,
      anomalyId,
      action,
      actorId: actor(user),
      data: json(data),
    },
  });
}
async function command(user, fn, db = prisma) {
  if (!user?.tenantId) fail(401, "Authentication required");
  return attendanceTransaction(db, user.tenantId, async (tx) => {
    await lockAttendancePeriod(tx, user.tenantId, true);
    return fn(tx);
  });
}
export async function listRuleCases(
  { user, from, to, status, employeeId, page = 1, pageSize = 30 },
  db = prisma,
) {
  const employees = await db.employee.findMany({
    where: {
      tenant_id: user.tenantId,
      ...(!isAttendanceHr(user)
        ? {
            OR: [
              { id: Number(user.employeeId) || -1 },
              { managerId: Number(user.employeeId) || -1 },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      employee_name: true,
      first_name: true,
      last_name: true,
      managerId: true,
    },
  });
  const ids = employees.map((e) => e.id);
  if (employeeId && !ids.includes(employeeId))
    fail(403, "Employee is outside your scope");
  const where = {
    tenantId: user.tenantId,
    rulesVersion: 2,
    employeeId: employeeId || { in: ids },
    date: { gte: dateOnly(from), lte: dateOnly(to) },
    ...(status ? { status } : {}),
  };
  const [items, total] = await Promise.all([
    db.attendanceAnomaly.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.attendanceAnomaly.count({ where }),
  ]);
  return {
    items: items.map((a) => ({
      ...a,
      employee: employees.find((e) => e.id === a.employeeId),
    })),
    total,
    page,
    pageSize,
    canDecide: isManagement(user),
    canEnter: isAttendanceHr(user),
  };
}
export async function ruleCaseDetail({ user, anomalyId }, db = prisma) {
  const row = await db.attendanceAnomaly.findFirst({
    where: { tenantId: user.tenantId, id: anomalyId, rulesVersion: 2 },
  });
  if (!row) fail(404, "Anomaly not found");
  const employee = await employeeScope(db, user, row.employeeId);
  const run = await db.payrollRun.findFirst({
    where: {
      tenantId: user.tenantId,
      periodStart: { lte: row.date },
      periodEnd: { gte: row.date },
      status: { notIn: ["CANCELLED", "FAILED"] },
    },
    orderBy: { id: "desc" },
  });
  const period = {
    from: run?.periodStart || dateOnly(dateKey(row.date).slice(0, 7) + "-01"),
    to:
      run?.periodEnd ||
      new Date(
        Date.UTC(
          new Date(row.date).getUTCFullYear(),
          new Date(row.date).getUTCMonth() + 1,
          0,
        ),
      ),
  };
  const [history, attendance, periodCases] = await Promise.all([
    db.attendanceRuleAudit.findMany({
      where: {
        tenantId: user.tenantId,
        employeeId: row.employeeId,
        OR: [
          { anomalyId },
          {
            action: "MANUAL_TIME_ENTERED",
            data: { path: ["sessionKey"], equals: row.sessionKey },
          },
        ],
      },
      orderBy: { id: "asc" },
    }),
    db.attendance.findFirst({
      where: {
        tenantId: user.tenantId,
        employeeId: row.employeeId,
        date: row.date,
      },
    }),
    db.attendanceAnomaly.findMany({
      where: {
        tenantId: user.tenantId,
        employeeId: row.employeeId,
        rulesVersion: 2,
        date: { gte: period.from, lte: period.to },
      },
    }),
  ]);
  return {
    anomaly: row,
    employee,
    history,
    attendance,
    period: { ...period, provisional: !run },
    assessment: ruleDeductions(periodCases),
    preview: ruleDeductions(
      periodCases.map((a) =>
        a.id === row.id
          ? { ...a, status: "REJECTED", decisionRole: "Management" }
          : a,
      ),
    ),
    canDecide: isManagement(user) && row.employeeId !== Number(user.employeeId),
    canEnter: isAttendanceHr(user),
    commentKinds: [
      ...(row.employeeId === Number(user.employeeId) ? ["EMPLOYEE"] : []),
      ...(employee.managerId === Number(user.employeeId) ? ["MANAGER"] : []),
      ...(isAttendanceHr(user) ? ["HR"] : []),
    ],
  };
}
export async function commentRuleCase(
  { user, anomalyId, version, kind, comment, recommendation },
  db = prisma,
) {
  if (!comment?.trim()) fail(400, "A comment is required");
  return command(
    user,
    async (tx) => {
      const row = await tx.attendanceAnomaly.findFirst({
        where: { tenantId: user.tenantId, id: anomalyId, rulesVersion: 2 },
      });
      if (!row) fail(404, "Anomaly not found");
      const employee = await employeeScope(tx, user, row.employeeId);
      const allowed =
        kind === "EMPLOYEE"
          ? row.employeeId === Number(user.employeeId)
          : kind === "MANAGER"
            ? employee.managerId === Number(user.employeeId)
            : kind === "HR" && isAttendanceHr(user);
      if (!allowed) fail(403, "You cannot comment in this role");
      if (row.status !== "PENDING" || row.evidenceState !== "ACTIVE")
        fail(409, "The anomaly is closed");
      const changed = await tx.attendanceAnomaly.updateMany({
        where: {
          tenantId: user.tenantId,
          id: anomalyId,
          workflowVersion: version,
          status: "PENDING",
        },
        data: {
          workflowVersion: { increment: 1 },
          ...(kind === "EMPLOYEE" ? { reason: comment.trim() } : {}),
        },
      });
      if (changed.count !== 1)
        fail(409, "Anomaly changed; refresh before commenting");
      await audit(
        tx,
        user,
        "COMMENT",
        {
          kind,
          comment: comment.trim(),
          recommendation: kind === "MANAGER" ? recommendation : null,
          factHash: row.factHash,
        },
        row.employeeId,
        row.id,
      );
      return { saved: true };
    },
    db,
  );
}
export async function finalizeRuleCase(
  { user, anomalyId, version, decision, comment },
  db = prisma,
) {
  const current=await db.attendanceAnomaly.findFirst({where:{tenantId:user.tenantId,id:anomalyId}});
  if(!current) fail(404,'Anomaly not found');
  await requireApproval(db,user.tenantId,'ATTENDANCE',`${anomalyId}@${current.factHash}`,decision==='APPROVED');
  if (!["APPROVED", "REJECTED"].includes(decision) || !comment?.trim())
    fail(400, "A decision and reason are required");
  return command(
    user,
    async (tx) => {
      const row = await tx.attendanceAnomaly.findFirst({
        where: { tenantId: user.tenantId, id: anomalyId, rulesVersion: 2 },
      });
      if (!row) fail(404, "Anomaly not found");
      if (row.employeeId === Number(user.employeeId))
        fail(
          403,
          "An independent Management user must decide your own anomaly",
        );
      if (row.status !== "PENDING" || row.evidenceState !== "ACTIVE")
        fail(409, "The anomaly is already closed");
      const job = await tx.attendanceEvaluationJob.findFirst({
        where: {
          tenantId: user.tenantId,
          employeeId: row.employeeId,
          date: row.date,
          rulesReconciliation: true,
          state: { in: ["PENDING", "FAILED"] },
        },
      });
      if (job)
        fail(
          409,
          "Rule re-evaluation is pending; review the refreshed evidence when it completes",
        );
      const attendance = await tx.attendance.findFirst({
        where: {
          tenantId: user.tenantId,
          employeeId: row.employeeId,
          date: row.date,
        },
      });
      const session = attendance?.calculation?.sessions?.find(
        (s) => s.sessionKey === row.sessionKey,
      );
      if (
        !session ||
        session.verdict.processingState === "AWAITING_DATA" ||
        ["SETUP_REQUIRED", "PUNCH_CONFLICT"].includes(session.verdict.status) ||
        (session.verdict.issues || []).some((i) => i.code !== "UNMATCHED_OUT")
      )
        fail(
          409,
          "Resolve the shift evidence hold before deciding this anomaly",
        );
      const verification = await tx.attendanceRuleAudit.findFirst({
        where: {
          tenantId: user.tenantId,
          anomalyId,
          action: "COMMENT",
          data: { path: ["kind"], equals: "HR" },
        },
        orderBy: { id: "desc" },
      });
      if (!verification || verification.data.factHash !== row.factHash)
        fail(
          409,
          "HR must record verification of the current evidence before Management decides",
        );
      const changed = await tx.attendanceAnomaly.updateMany({
        where: {
          tenantId: user.tenantId,
          id: anomalyId,
          workflowVersion: version,
          status: "PENDING",
          evidenceState: "ACTIVE",
        },
        data: {
          status: decision,
          decisionRole: "Management",
          decidedAt: new Date(),
          reviewerId: Number(user.employeeId) || null,
          reviewNote: comment.trim(),
          workflowVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        fail(409, "Anomaly changed; refresh the evidence before deciding");
      await audit(
        tx,
        user,
        "MANAGEMENT_DECISION",
        { decision, comment: comment.trim(), factHash: row.factHash, version },
        row.employeeId,
        row.id,
      );
      await reconcileRulePayroll(tx, {
        tenantId: user.tenantId,
        employeeId: row.employeeId,
        date: row.date,
        actorId: actor(user),
      });
      await applyEvaluatedShifts({
        tenantId: user.tenantId,
        employeeIds: [row.employeeId],
        from: dateKey(row.date),
        to: dateKey(row.date),
        db: tx,
        dryRun: false,
        rulesReconciliation: true,
        trigger: "MANAGEMENT_DECISION",
      });
      return { saved: true, decision };
    },
    db,
  );
}
export async function enterRuleTime(
  { user, employeeId, date, sessionKey, checkIn, checkOut, reason, version },
  db = prisma,
) {
  requireHr(user);
  if (!reason?.trim() || (!checkIn && !checkOut))
    fail(400, "A missing time and its reason are required");
  return command(
    user,
    async (tx) => {
      await employeeScope(tx, user, employeeId);
      await assertAttendancePeriodOpen(tx, user.tenantId, date, date);
      const row = await tx.attendance.findFirst({
        where: { tenantId: user.tenantId, employeeId, date: dateOnly(date) },
      });
      if ((row?.evaluationVersion || 0) !== version)
        fail(409, "Attendance changed; refresh before entering a time");
      const sessions = await replayTenant({
        tenantId: user.tenantId,
        employeeIds: [employeeId],
        from: date,
        to: date,
        db: tx,
        includeEmpty: true,
      });
      const selected = sessionKey
        ? sessions.find((s) => s.sessionKey === sessionKey)
        : sessions.length === 1
          ? sessions[0]
          : null;
      if (!selected) fail(400, "Select the specific scheduled shift");
      if (!selected.setupSnapshot.working || !selected.shift?.start)
        fail(400, "A published scheduled shift is required");
      if (date > dateKey(civilNow(new Date(), selected.setupSnapshot.timeZone)))
        fail(400, "Future attendance cannot be entered");
      const proposed = {
        IN: selected.verdict.checkIn,
        OUT: selected.verdict.checkOut,
      };
      const entries = [];
      for (const [direction, time, existing] of [
        ["IN", checkIn, selected.verdict.checkIn],
        ["OUT", checkOut, selected.verdict.checkOut],
      ]) {
        if (!time) continue;
        if (existing)
          fail(
            409,
            `The ${direction === "IN" ? "check-in" : "check-out"} is already recorded and cannot be overwritten`,
          );
        if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time))
          fail(400, "Enter a time in HH:MM or HH:MM:SS format");
        let timestamp = new Date(
          `${date}T${time.length === 5 ? time + ":00" : time}Z`,
        );
        if (
          direction === "OUT" &&
          +selected.shift.end >= +dateOnly(date) + 86400000 &&
          timestamp < selected.shift.start
        )
          timestamp = new Date(+timestamp + 86400000);
        if (
          direction === "IN" &&
          +selected.shift.end >= +dateOnly(date) + 86400000 &&
          timestamp < new Date(+selected.shift.start - 6 * 3600000)
        )
          timestamp = new Date(+timestamp + 86400000);
        if (timestamp > civilNow(new Date(), selected.setupSnapshot.timeZone))
          fail(400, "A future punch cannot be entered");
        proposed[direction] = timestamp;
        entries.push({ direction, timestamp });
      }
      if (proposed.IN && proposed.OUT && +proposed.IN >= +proposed.OUT)
        fail(400, "Check-out must be later than check-in");
      for (const { direction, timestamp } of entries) {
        const saved = await tx.attendanceManualTime.create({
          data: {
            tenantId: user.tenantId,
            employeeId,
            date: dateOnly(date),
            sessionKey: selected.sessionKey,
            direction,
            timestamp,
            actorId: actor(user),
            reason: reason.trim(),
          },
        });
        await audit(tx, user, "MANUAL_TIME_ENTERED", saved, employeeId);
      }
      const result = await applyEvaluatedShifts({
        tenantId: user.tenantId,
        employeeIds: [employeeId],
        from: date,
        to: date,
        db: tx,
        dryRun: false,
        trigger: "HR_MISSING_TIME",
      });
      return { saved: true, evaluation: result };
    },
    db,
  );
}
export async function rulesConfiguration({ user }, db = prisma) {
  requireHr(user);
  const [rules, memberships, employees, jobs, legacyPayslips, failures] =
    await Promise.all([
      db.attendanceGraceRule.findMany({
        where: { tenantId: user.tenantId },
        orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }],
      }),
      db.attendanceGraceMembership.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { effectiveFrom: "desc" },
      }),
      db.employee.findMany({
        where: { tenant_id: user.tenantId },
        select: { id: true, employee_name: true, employee_code: true },
      }),
      db.attendanceEvaluationJob.groupBy({
        by: ["state"],
        where: { tenantId: user.tenantId, rulesReconciliation: true },
        _count: true,
      }),
      db.payrollPayslip.findMany({
        where: { tenantId: user.tenantId, attendanceBasisMinor: null },
        select: {
          id: true,
          employeeId: true,
          payrollRunId: true,
          status: true,
        },
        orderBy: { id: "asc" },
        take: 50,
      }),
      db.attendanceEvaluationJob.findMany({
        where: {
          tenantId: user.tenantId,
          rulesReconciliation: true,
          lastError: { not: null },
        },
        select: { employeeId: true, date: true, lastError: true },
        take: 25,
        orderBy: { date: "asc" },
      }),
    ]);
  return {
    rules,
    memberships,
    employees,
    jobs,
    legacyPayslips,
    failures,
    canAdoptPricing: isManagement(user),
  };
}
export async function adoptHistoricalPricing(
  { user, payslipId, basis, reason },
  db = prisma,
) {
  requireManagement(user);
  if (!reason?.trim() || !/^\d+(\.\d{1,4})?$/.test(String(basis)))
    fail(400, "Enter the documented historical salary basis and its source");
  return command(
    user,
    async (tx) => {
      const slip = await tx.payrollPayslip.findFirst({
        where: { tenantId: user.tenantId, id: payslipId },
        include: { deductions: { include: { deductionType: true } } },
      });
      if (!slip) fail(404, "Payslip not found");
      if (slip.attendanceBasisMinor != null)
        fail(409, "This payslip already has a frozen pricing basis");
      const run = await tx.payrollRun.findFirst({
        where: { tenantId: user.tenantId, id: slip.payrollRunId },
      });
      if (!run || ["PROCESSING", "CANCELLED", "FAILED"].includes(run.status))
        fail(409, "The payroll run is unavailable for pricing adoption");
      const basisMinor = String(
        money.decimalToMinor(String(basis), run.currencyCode),
      );
      const periodDays = dateRange(run.periodStart, run.periodEnd, 370).length;
      const lines = slip.deductions.filter((d) =>
        LEGACY_ATTENDANCE_CODES.includes(d.deductionType?.code),
      );
      await tx.payrollPayslip.update({
        where: { id: payslipId, tenantId: user.tenantId },
        data: {
          attendanceBasisMinor: basisMinor,
          attendancePeriodDays: periodDays,
        },
      });
      await tx.payrollAuditLog.create({
        data: {
          tenantId: user.tenantId,
          employeeId: slip.employeeId,
          payslipId,
          payrollRunId: run.id,
          action: "ATTENDANCE_PRICING_ADOPTED",
          details: `Historical pricing verified by ${actor(user)}: ${reason.trim()}`,
          newValues: {
            basisMinor,
            periodDays,
            deductionIds: lines.map((d) => d.id),
            originalLines: json(lines),
          },
        },
      });
      await audit(
        tx,
        user,
        "PRICING_BASELINE_ADOPTED",
        { payslipId, basisMinor, periodDays, reason },
        slip.employeeId,
      );
      await enqueueRetroactive(tx, user, dateKey(run.periodStart), [
        slip.employeeId,
      ]);
      return { saved: true, queued: true };
    },
    db,
  );
}
async function enqueueRetroactive(tx, user, effectiveFrom, employeeIds) {
  const today = dateKey(civilNow(new Date(), "Asia/Karachi"));
  // Missing historical setup becomes an explicit evaluation hold; never silently
  // discard the portion of a requested retrospective change before a release.
  const first = dateKey(effectiveFrom);
  for (let from = first; from <= today; from = dateKey(addDays(from, 30))) {
    const to = [dateKey(addDays(from, 29)), today].sort()[0];
    const rows = dateRange(from, to).flatMap((date) =>
      employeeIds.map((employeeId) => ({
        tenantId: user.tenantId,
        employeeId,
        date: dateOnly(date),
        rulesReconciliation: true,
        state: "PENDING",
        nextAttemptAt: new Date(),
      })),
    );
    for (let i = 0; i < rows.length; i += 500)
      await tx.attendanceEvaluationJob.createMany({
        data: rows.slice(i, i + 500),
        skipDuplicates: true,
      });
    await tx.attendanceEvaluationJob.updateMany({
      where: {
        tenantId: user.tenantId,
        employeeId: { in: employeeIds },
        date: { gte: dateOnly(from), lte: dateOnly(to) },
      },
      data: {
        rulesReconciliation: true,
        state: "PENDING",
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });
  }
}
export async function saveGraceRule(
  {
    user,
    scope,
    scopeKey,
    effectiveFrom,
    checkInMinutes,
    checkOutMinutes,
    reason,
    version,
  },
  db = prisma,
) {
  requireHr(user);
  if (
    !["COMPANY", "DEPARTMENT", "TEAM", "EMPLOYEE", "SHIFT"].includes(scope) ||
    !scopeKey?.trim() ||
    !reason?.trim()
  )
    fail(400, "Scope, key and reason are required");
  for (const value of [checkInMinutes, checkOutMinutes])
    if (
      value != null &&
      (!Number.isInteger(value) || value < 0 || value > 1440)
    )
      fail(
        400,
        "Grace must be whole minutes from 0 to 1440, or blank to inherit",
      );
  return command(
    user,
    async (tx) => {
      const key = {
        tenantId: user.tenantId,
        scope,
        scopeKey: scope === "COMPANY" ? "*" : scopeKey.trim(),
        effectiveFrom: dateOnly(effectiveFrom),
      };
      if (scope === "EMPLOYEE") await employeeScope(tx, user, Number(scopeKey));
      const old = await tx.attendanceGraceRule.findFirst({ where: key });
      if ((old?.version ?? -1) !== version)
        fail(409, "Grace settings changed; refresh before saving");
      const data = {
        checkInMinutes: checkInMinutes ?? null,
        checkOutMinutes: checkOutMinutes ?? null,
        actorId: actor(user),
        reason: reason.trim(),
      };
      const saved = old
        ? await tx.attendanceGraceRule.update({
            where: { id: old.id, tenantId: user.tenantId, version },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.attendanceGraceRule.create({ data: { ...key, ...data } });
      await audit(tx, user, "GRACE_CHANGED", { before: old, after: saved });
      const employees = await tx.employee.findMany({
        where: {
          tenant_id: user.tenantId,
          ...(scope === "EMPLOYEE" ? { id: Number(scopeKey) } : {}),
        },
        select: { id: true },
      });
      await enqueueRetroactive(
        tx,
        user,
        effectiveFrom,
        employees.map((e) => e.id),
      );
      return { saved, queued: true };
    },
    db,
  );
}
export async function saveGraceMembership(
  { user, employeeId, effectiveFrom, teamKey, departmentKey, version, reason },
  db = prisma,
) {
  requireHr(user);
  if (!reason?.trim()) fail(400, "A reason is required");
  return command(
    user,
    async (tx) => {
      await employeeScope(tx, user, employeeId);
      const key = {
        tenantId: user.tenantId,
        employeeId,
        effectiveFrom: dateOnly(effectiveFrom),
      };
      const old = await tx.attendanceGraceMembership.findFirst({ where: key });
      if ((old?.version ?? -1) !== version)
        fail(409, "Membership changed; refresh before saving");
      const data = {
        teamKey: teamKey?.trim() || null,
        departmentKey: departmentKey?.trim() || null,
      };
      const saved = old
        ? await tx.attendanceGraceMembership.update({
            where: { id: old.id, tenantId: user.tenantId, version },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.attendanceGraceMembership.create({
            data: { ...key, ...data },
          });
      await audit(
        tx,
        user,
        "GRACE_MEMBERSHIP_CHANGED",
        { before: old, after: saved, reason },
        employeeId,
      );
      await enqueueRetroactive(tx, user, effectiveFrom, [employeeId]);
      return { saved, queued: true };
    },
    db,
  );
}

export async function decideRuleCase({anomalyId}) { return legacyDecision("ATTENDANCE",anomalyId); }
