import { randomUUID } from "node:crypto";
import { legacyDecision } from './approval/legacy.js';
import { requireApproval } from './approval/adapters.js';
import {
  submitApproval,
  submitApprovalOnBehalf,
} from "./approval/service.js";
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
import { loadAttendanceRuntime } from '../lib/attendanceRuntime.js';
import { attendanceViewMatches, shiftKey } from '../lib/attendanceViewFilters.js';

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
// Display name for the filer snapshot. Mirrors attendanceAnomaly.service.js:
// the denormalised name wins, otherwise the composed one.
const fullName = (emp) => {
  if (!emp) return null;
  const denormalised = emp.employee_name && emp.employee_name.trim();
  if (denormalised) return denormalised;
  return `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || null;
};
export async function employeeScope(db, user, employeeId) {
  const employee = await db.employee.findFirst({
    where: { id: employeeId, tenant_id: user.tenantId },
  });
  if (!employee) fail(404, "Employee not found");
  if (
    !isAttendanceHr(user) && !isManagement(user) &&
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
  { user, from, to, status, employeeId, q, category, site, department, shift, page = 1, pageSize = 30 },
  db = prisma,
) {
  dateRange(from,to,370);
  page=Math.max(1,Number(page)||1); pageSize=Math.min(100,Math.max(1,Number(pageSize)||30));
  const employees = await db.employee.findMany({
    where: {
      tenant_id: user.tenantId,
      ...(!isAttendanceHr(user) && !isManagement(user)
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
      employee_code: true,
      managerId: true,
    },
  });
  const ids = employees.map((e) => e.id);
  if (employeeId && !ids.includes(employeeId))
    fail(403, "Employee is outside your scope");
  const where = {
    tenantId: user.tenantId,
    employeeId: { in: employees.filter(e => (!employeeId || e.id === employeeId) && (!q || e.employee_code?.toLowerCase().includes(q.toLowerCase()))).map(e => e.id) },
    date: { gte: dateOnly(from), lte: dateOnly(to) },
    ...(status ? { status } : {}),
  };
  // One snapshot supplies both the cards and the paginated review table.
  // Include legacy cases: they were already counted by the timesheet cards.
  const fetched = await db.attendanceAnomaly.findMany({
      where,
      orderBy: [{ date: "desc" }, { id: "desc" }],
  });
  const categoryOf = row => row.type==='ABSENT'?'absent':row.type==='LATE_CHECKIN'?'late':row.type==='EARLY_CHECKOUT'?'early':'other';
  const runtime = site || department || shift ? await loadAttendanceRuntime({tenantId:user.tenantId,from,to,db}) : null;
  const all = fetched.filter(row => (!category || categoryOf(row) === category) && (!runtime || attendanceViewMatches(runtime.resolve(row.employeeId,row.date),{site,department,shift})));
  const summary={absent:0,late:0,early:0,other:0,total:all.length};
  for(const row of all) summary[categoryOf(row)]++;
  const items=all.slice((page-1)*pageSize,page*pageSize);
  return {
    items: items.map((a) => ({
      ...a,
      employee: employees.find((e) => e.id === a.employeeId),
    })),
    total:all.length,
    summary,
    observedAt: new Date().toISOString(),
    page,
    pageSize,
    canDecide: isManagement(user),
    canEnter: isAttendanceHr(user),
  };
}
export async function attendanceFilterOptions({user,from,to},db=prisma) {
  const days=dateRange(from,to,370);
  const [runtime,employees,departments] = await Promise.all([
    loadAttendanceRuntime({tenantId:user.tenantId,from,to,db}),
    db.employee.findMany({where:{tenant_id:user.tenantId,...(!isAttendanceHr(user)&&!isManagement(user)?{OR:[{id:Number(user.employeeId)||-1},{managerId:Number(user.employeeId)||-1}]}:{})},select:{id:true}}),
    db.businessUnit.findMany({where:{tenantId:user.tenantId},select:{id:true,name:true},orderBy:{name:'asc'}}),
  ]);
  const sites=new Map(), shifts=new Set();
  for(const employee of employees) for(const day of days) {
    const info=runtime.resolve(employee.id,day);
    const key=shiftKey(info.shift); if(key) shifts.add(key);
    for(const site of info.sites||[]) if(info.siteAssignment?.siteIds?.includes(site.id)) sites.set(site.id,site.name);
  }
  // Departments are the company's own list, not "departments seen in this
  // window". The scope's department select must offer every department the
  // company has (operator item 19): filtering to departments that happened to
  // resolve for these dates hid a department with no scheduled staff yet, so an
  // empty timesheet looked like a missing department rather than no rows.
  return {sites:[...sites].map(([id,name])=>({id,name})),departments:departments.map(d=>({id:d.id,name:d.name})),shifts:[...shifts].sort().map(key=>({id:key,name:key}))};
}
export async function myAttendanceDay({user},db=prisma) {
  if(!user.employeeId) return {linked:false};
  const employee=await employeeScope(db,user,Number(user.employeeId));
  const utcDay=dateKey(new Date());
  const runtime=await loadAttendanceRuntime({tenantId:user.tenantId,from:addDays(utcDay,-1),to:addDays(utcDay,15),db});
  const zone=runtime.configOn(utcDay)?.settings?.timeZone || 'Asia/Karachi';
  const day=dateKey(civilNow(new Date(),zone)),plan=runtime.resolve(employee.id,day);
  let nextShift=null;
  for(const next of dateRange(addDays(day,1),addDays(day,14),14)) {const info=runtime.resolve(employee.id,next);if(info.working && info.shift?.start){nextShift={date:next,...info.shift};break;}}
  const [record,requests]=await Promise.all([db.attendance.findFirst({where:{tenantId:user.tenantId,employeeId:employee.id,date:dateOnly(day)}}),db.hrApprovalRequest.findMany({where:{tenantId:user.tenantId,employeeCode:employee.employee_code,kind:{in:['ATTENDANCE_CORRECTION','ATTENDANCE','LEAVE','OVERTIME','SHIFT_SWAP','TIME_CREDIT']}},orderBy:{updatedAt:'desc'},take:10})]);
  return {linked:true,employeeCode:employee.employee_code,date:day,timeZone:zone,shift:plan.shift,calendar:plan.calendarStatus || (plan.working?'WORKDAY':plan.reason),sites:(plan.sites||[]).filter(site=>plan.siteAssignment?.siteIds?.includes(site.id)).map(site=>site.name),record:record?{checkIn:record.check_in,checkOut:record.check_out,status:record.status,processing:record.processingState}:null,nextShift,requests:requests.map(r=>({reference:r.id,sourceRef:r.sourceRef,kind:r.kind,stage:r.stage,updatedAt:r.updatedAt}))};
}
export async function exportAttendanceRecords({user,...filters},db=prisma) {
  dateRange(filters.from,filters.to,92);
  const employees=await db.employee.findMany({where:{tenant_id:user.tenantId,...(!isAttendanceHr(user)&&!isManagement(user)?{OR:[{id:Number(user.employeeId)||-1},{managerId:Number(user.employeeId)||-1}]}:{})},select:{id:true}});
  const {listCheckInOuts}=await import('./timesheetReport.service.js');
  const result=await listCheckInOuts({...filters,tenantId:user.tenantId,employeeIds:employees.map(e=>e.id),exportMode:true,page:1});
  if(result.total>20000) fail(422,'This export exceeds 20,000 rows. Narrow the dates or scope; no partial file was generated.');
  const generatedAt=new Date().toISOString();
  const receipt=await audit(db,user,'ATTENDANCE_EXPORTED',{filters,rows:result.total,generatedAt});
  return {reference:receipt.id,generatedAt,company:user.tenantId,filters,total:result.total,items:result.items.map(row=>({employeeCode:row.employee?.code,date:dateKey(row.date),calendar:row.calendarStatus,outcome:row.status,processing:row.processingState,checkIn:row.checkIn,checkOut:row.checkOut,decimalHours:row.totalHours,timeZone:row.timeZone}))};
}
export async function employeeCodeOptions({ user, q = '', page = 1, pageSize = 50 }, db = prisma) {
  // Operator item 19: search matches the employee's NAME as well as the code,
  // so HR can type "Ayesha" instead of remembering EMP-014. Both predicates sit
  // under AND with the permission scope — the scope is itself an OR, and a
  // flat spread would let one OR overwrite the other and leak other managers'
  // staff.
  const scope = !isAttendanceHr(user) && !isManagement(user)
    ? { OR: [{ id: Number(user.employeeId) || -1 }, { managerId: Number(user.employeeId) || -1 }] }
    : {};
  const term = String(q || '').trim();
  const match = term
    ? { OR: ['employee_code', 'first_name', 'middle_name', 'last_name', 'preferred_name'].map((field) => ({ [field]: { contains: term, mode: 'insensitive' } })) }
    : {};
  const clauses = [scope, match].filter((clause) => Object.keys(clause).length);
  const where = { tenant_id: user.tenantId, ...(clauses.length ? { AND: clauses } : {}) };
  const select = { id: true, employee_code: true, first_name:true, middle_name:true, last_name:true, preferred_name:true, status:true, hire_date:true, businessUnit:{select:{name:true}} };
  const exact = term ? await db.employee.findFirst({ where: {...where, employee_code:{equals:term,mode:'insensitive'}}, select }) : null;
  const [remaining, total] = await Promise.all([
    db.employee.findMany({ where: {...where,...(exact?{id:{not:exact.id}}:{})}, select, orderBy: { employee_code: 'asc' }, skip: Math.max(0,(page - 1) * pageSize - (exact ? 1 : 0)), take: pageSize - (exact && page === 1 ? 1 : 0) }),
    db.employee.count({ where }),
  ]);
  const rows = exact && page === 1 ? [exact,...remaining] : remaining;
  const nameOf = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ') || e.preferred_name || e.middle_name || null;
  return { items: rows.filter(e => e.employee_code).map(e => ({ id: e.id, code: e.employee_code, name:nameOf(e), department:e.businessUnit?.name,status:e.status,activeFrom:e.hire_date })), total, page, pageSize };
}
export async function ruleCaseDetail({ user, anomalyId }, db = prisma) {
  const row = await db.attendanceAnomaly.findFirst({
    where: { tenantId: user.tenantId, id: anomalyId },
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
    history: await (async()=>{const {attendanceActorCodes}=await import('../lib/attendanceActorCodes.js');const codes=await attendanceActorCodes(db,user.tenantId,history.map(a=>a.actorId));return history.map(a=>({...a,actorCode:codes.get(String(a.actorId)) || null}));})(),
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
    legacy: row.rulesVersion !== 2,
    canDecide: row.rulesVersion===2 && isManagement(user) && row.employeeId !== Number(user.employeeId),
    canEnter: row.rulesVersion===2 && isAttendanceHr(user),
    commentKinds: row.rulesVersion!==2 ? [] : [
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
// ── TS-REQUEST-HYBRID-01 (operator, 2026-10-27) ─────────────────────────────
// Raising the resolution request for a case the rules engine detected.
//
// The hybrid model: the evaluator detects the anomaly and the Timesheet shows
// it immediately (Late Check-in / Early Check-out / …) with the Request column
// reading "Not Submitted". The request is then raised by the EMPLOYEE, or by HR
// ON THEIR BEHALF, with a single free-text reason. Everything else — type,
// date, expected/actual time, measured minutes, session — is already derived by
// the evaluator and the decision route is fixed, so the raise takes no other
// input.
//
// The raise COMPLETES the existing rules-v2 case and never creates a second
// anomaly row: the ATTENDANCE approval adapter refuses to finalize a source
// that is not rules-v2 ("Re-evaluate this legacy attendance case under the
// current evidence rules"), so a legacy-shaped row could never be decided.
//   • `reason` and the filer snapshot are stamped here — the reason is the only
//     content an approver judges, and the approval seals a snapshot of it (the
//     ATTENDANCE field list in approval/adapters.js);
//   • the approval is created against `<anomalyId>@<factHash>`, the reference
//     `finalizeRuleCase` consumes when Management decides — so APPROVED
//     resolves the case with NO payroll deduction and REJECTED deducts (only
//     REJECTED + decisionRole=Management cases are priced: ruleDeductions);
//   • the Level-1 manager stage is PAUSED (lib/approvalStagePolicy.js), so the
//     submitted request lands in HR verification and Management then decides.
//
// Raising is deliberately the LAST write before submission: the approval binds
// to the current fact hash, so any later evidence change invalidates it and the
// centre asks for a fresh review instead of deciding on stale facts.
const REASON_LIMIT = 4000;

// The raise targets one case. Callers that already show the case (the Timesheet
// row) pass its id; the employee's own dialog is about a DAY, so it passes the
// date — and the type when the day carries more than one case (a late check-in
// and a missing check-out can coexist on one day).
async function resolveCaseId(tx, user, { anomalyId, date, type, employeeId }) {
  if (anomalyId) return anomalyId;
  if (!date) fail(400, "An attendance case id, or the work date, is required");
  // The subject is the caller on a self raise and the named employee on an
  // on-behalf one — never the caller, who is HR in that case.
  const owner = employeeId != null ? Number(employeeId) : Number(user.employeeId);
  if (!Number.isInteger(owner) || owner < 1)
    fail(400, "The employee is required to raise a case by date");
  const rows = await tx.attendanceAnomaly.findMany({
    where: {
      tenantId: user.tenantId,
      employeeId: owner,
      date: dateOnly(date),
      rulesVersion: 2,
      status: "PENDING",
      evidenceState: "ACTIVE",
      ...(type ? { type } : {}),
    },
    select: { id: true, type: true },
    orderBy: { id: "asc" },
  });
  if (!rows.length) fail(404, "No open attendance case for that day");
  if (rows.length > 1)
    fail(
      409,
      `That day has ${rows.length} open cases (${rows
        .map((row) => row.type)
        .join(", ")}); raise the one you mean`,
    );
  return rows[0].id;
}

async function assertRaiseable(tx, user, anomalyId, { onBehalf }) {
  const row = await tx.attendanceAnomaly.findFirst({
    where: { tenantId: user.tenantId, id: anomalyId, rulesVersion: 2 },
  });
  if (!row) fail(404, "Attendance case not found");
  await employeeScope(tx, user, row.employeeId);
  if (onBehalf) {
    // HR filing for an employee. The approval centre re-asserts the HR grant
    // on submission (submitApprovalOnBehalf); here we only establish the
    // attendance-side scope and refuse a pointless on-behalf raise of the
    // caller's own case.
    requireHr(user);
    if (Number(user.employeeId) === row.employeeId)
      fail(403, "Raise your own case from your own account");
  } else if (row.employeeId !== Number(user.employeeId)) {
    fail(403, "Only the employee concerned may raise this case");
  }
  if (row.status !== "PENDING" || row.evidenceState !== "ACTIVE")
    fail(409, "This case is already closed");
  return row;
}

async function raiseRuleCase(
  { user, anomalyId, date, type, employeeId, reason, requestKey, onBehalf = false },
  db = prisma,
) {
  if (!user?.tenantId) fail(401, "Authentication required");
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) fail(400, "A reason is required to raise the request");
  if (trimmed.length > REASON_LIMIT)
    fail(400, `The reason must be at most ${REASON_LIMIT} characters`);
  // Phase 1 — complete the case. Its own transaction: the approval service owns
  // its own locking and idempotency receipt, and nesting the two would take the
  // attendance period lock and the anomaly row lock out of order.
  const prepared = await command(
    user,
    async (tx) => {
      const targetId = await resolveCaseId(tx, user, {
        anomalyId,
        date,
        type,
        employeeId,
      });
      const row = await assertRaiseable(tx, user, targetId, { onBehalf });
      if (onBehalf && employeeId != null && Number(employeeId) !== row.employeeId)
        fail(400, "The case belongs to a different employee");
      const filerId = Number(user.employeeId) || null;
      // raisedById === the subject's own id on a self raise, which is how the
      // Timesheet tells a self-filed request from an on-behalf one.
      const onBehalfRaise = onBehalf && filerId != null && filerId !== row.employeeId;
      let raisedByName = null;
      if (onBehalfRaise) {
        const filer = await tx.employee.findFirst({
          where: { tenant_id: user.tenantId, id: filerId },
          select: { employee_name: true, first_name: true, last_name: true },
        });
        raisedByName = fullName(filer);
      }
      const employee = await tx.employee.findFirst({
        where: { tenant_id: user.tenantId, id: row.employeeId },
        select: {
          employee_code: true,
          Position: { select: { title: true } },
          businessUnit: { select: { name: true } },
        },
      });
      if (!employee?.employee_code)
        fail(422, "The employee has no employee code; the request cannot be routed");
      const existing = await tx.hrApprovalRequest.findUnique({
        where: {
          tenantId_kind_sourceRef: {
            tenantId: user.tenantId,
            kind: "ATTENDANCE",
            sourceRef: `${row.id}@${row.factHash}`,
          },
        },
      });
      if (existing && existing.stage !== "INITIATOR")
        fail(
          409,
          `A resolution request for this case is already with ${
            existing.stage === "HR"
              ? "HR"
              : existing.stage === "MANAGEMENT"
                ? "Management"
                : existing.stage
          }`,
        );
      const changed = await tx.attendanceAnomaly.updateMany({
        where: { tenantId: user.tenantId, id: row.id, workflowVersion: row.workflowVersion },
        data: {
          reason: trimmed,
          applicationDate: new Date(),
          raisedById: onBehalfRaise ? filerId : row.employeeId,
          raisedByName,
          positionSnapshot: employee.Position?.title ?? null,
          departmentSnapshot: employee.businessUnit?.name ?? null,
          workflowVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        fail(409, "The case changed; refresh before raising the request");
      await audit(
        tx,
        user,
        onBehalfRaise ? "REQUEST_RAISED_ON_BEHALF" : "REQUEST_RAISED",
        { reason: trimmed, raisedById: onBehalfRaise ? filerId : row.employeeId },
        row.employeeId,
        row.id,
      );
      return {
        anomalyId: row.id,
        sourceRef: `${row.id}@${row.factHash}`,
        employeeCode: employee.employee_code,
        expectedVersion: existing?.version ?? 0,
      };
    },
    db,
  );
  // Phase 2 — hand it to the HR Approval Centre at the first engaged stage.
  const submit = onBehalf ? submitApprovalOnBehalf : submitApproval;
  const result = await submit({
    kind: "ATTENDANCE",
    sourceRef: prepared.sourceRef,
    employeeCode: prepared.employeeCode,
    expectedVersion: prepared.expectedVersion,
    reason: trimmed,
    requestKey: requestKey || randomUUID(),
  });
  return { ...result.record, anomalyId: prepared.anomalyId };
}

// The employee's own raise: "this is my day, here is my explanation".
export async function raiseRuleRequest(args, db = prisma) {
  return raiseRuleCase({ ...args, onBehalf: false }, db);
}

// TS-ONBEHALF-01 — HR raises the resolution request for an employee who has not
// answered their own case. Same lifecycle, same single reason; only the filer
// differs, and the filer is recorded on both the case and the approval trail.
export async function raiseRuleRequestOnBehalf(args, db = prisma) {
  return raiseRuleCase({ ...args, onBehalf: true }, db);
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
export async function enterRuleTime() {
  fail(410, 'Submit a missing-time correction through the employee, Line Manager, HR and Management approval workflow');
}

// Internal application step; public commands cannot call this directly.
export async function applyMissingTime(
  { user, employeeId, date, sessionKey, checkIn, checkOut, reason, version, validateOnly = false },
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
        if (selected.verdict.deadline && +timestamp > +new Date(selected.verdict.deadline))
          fail(400, 'The requested time is after this shift’s checkout cutoff; review the next scheduled shift');
        proposed[direction] = timestamp;
        entries.push({ direction, timestamp });
      }
      if (proposed.IN && proposed.OUT && +proposed.IN >= +proposed.OUT)
        fail(400, "Check-out must be later than check-in");
      if (validateOnly) return { valid: true, entries };
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
