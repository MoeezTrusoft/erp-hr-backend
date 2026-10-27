import { createHash } from "node:crypto";
import { employee } from "../separation/base.js";
import { assertAttendancePeriodOpen, lockAttendancePeriod } from "../attendancePeriod.service.js";
import { assertNoPayrollLoanReservation } from "../payrollLoans.service.js";
import { enqueueHrDomainEvent } from "../hrDomainEvent.service.js";
import { performanceReviewFinalizedEvent } from "../hrEvents.js";

export const fail = (message, status = 409) => {
  throw Object.assign(new Error(`HR-4200: ${message}`), {
    status,
    code: "HR-4200",
  });
};
export const json = (value) => JSON.parse(JSON.stringify(value));
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(json(value)))
    .digest("hex");
const definitions = {
  ATTENDANCE_CORRECTION: [
    "attendanceCorrectionRequest", "attendance_correction_requests", "employeeId", ["PENDING"],
    ["date", "sessionKey", "checkIn", "checkOut", "reason", "evidence", "reasonCategory", "evidenceDate", "evaluationVersion", "version"],
  ],
  TIME_CREDIT: [
    "attendanceTimeCredit",
    "attendance_time_credits",
    "employeeId",
    ["PENDING"],
    [
      "date",
      "kind",
      "start",
      "end",
      "fromSiteId",
      "toSiteId",
      "paid",
      "reason",
    ],
  ],
  TIME_CREDIT_REVOCATION: [
    "attendanceTimeCredit",
    "attendance_time_credits",
    "employeeId",
    ["APPROVED"],
    [
      "date",
      "kind",
      "start",
      "end",
      "fromSiteId",
      "toSiteId",
      "paid",
      "reason",
    ],
  ],
  SEPARATION_WITHDRAWAL: [
    "separation",
    "Separation",
    "employeeCode",
    null,
    ["type", "lastWorkingAt", "withdrawalRequestedAt"],
  ],
  SETTLEMENT: [
    "finalSettlementSheet",
    "FinalSettlementSheet",
    "employeeCode",
    ["PREPARED"],
    ["payload", "evidenceRefs"],
  ],
  LOAN_WRITEOFF: [
    "loan",
    "loans",
    "employeeId",
    ["ACTIVE"],
    ["principalMinor", "outstandingMinor", "kind", "reason"],
  ],
  OFFER: [
    "offer",
    "offers",
    "createdById",
    ["DRAFT"],
    [
      "applicationId",
      "candidateId",
      "jobRequisitionId",
      "salary",
      "currency",
      "startDate",
      "expiryDate",
      "notes",
      "offerType",
      "employmentType",
      "terms",
      "compensation",
    ],
  ],
  LEAVE: [
    "leaveRequest",
    "leave_requests",
    "employeeId",
    ["PENDING"],
    ["startDate", "endDate", "totalDays", "reason", "notes", "leavePolicyId"],
  ],
  OVERTIME: [
    "overtimeRequest",
    "overtime_requests",
    "employeeId",
    ["PENDING"],
    [
      "date",
      "hours",
      "rate",
      "project",
      "reason",
      "fromTime",
      "toTime",
      "source",
    ],
  ],
  CLAIM: [
    "reimbursementClaim",
    "reimbursement_claims",
    "employeeId",
    ["DRAFT", "SUBMITTED", "NEEDS_INFO"],
    [
      "title",
      "description",
      "amount",
      "currency",
      "category",
      "receiptMediaId",
      "notes",
    ],
  ],
  LOAN: [
    "loan",
    "loans",
    "employeeId",
    ["PENDING"],
    [
      "principalMinor",
      "interestRatePct",
      "tenureMonths",
      "disbursementDate",
      "kind",
      "monthlyInstallmentMinor",
      "reason",
    ],
  ],
  TIMESHEET: [
    "timesheet",
    "Timesheet",
    "employeeId",
    ["DRAFT", "SUBMITTED"],
    ["period_start", "period_end", "total_hours"],
  ],
  SHIFT_SWAP: [
    "shiftSwapRequest",
    "shift_swap_requests",
    "requesterId",
    ["PENDING"],
    ["targetId", "fromDate", "toDate", "shiftType", "reason"],
  ],
  GOAL: [
    "goal",
    "Goal",
    "employeeId",
    ["PENDING"],
    [
      "title",
      "description",
      "category",
      "start_date",
      "end_date",
      "target_value",
    ],
  ],
  REQUISITION: [
    "jobRequisition",
    "JobRequisition",
    "requestedById",
    ["DRAFT", "PENDING_APPROVAL"],
    [
      "title",
      "description",
      "departmentId",
      "positionId",
      "openings",
      "priority",
      "requirements",
    ],
  ],
  PAYROLL: [
    "payrollRun",
    "payroll_runs",
    "processedBy",
    ["COMPLETED"],
    [
      "periodStart",
      "periodEnd",
      "countryCode",
      "currencyCode",
      "totalGross",
      "totalDeductions",
      "totalNet",
      "employeeCount",
      "ruleVersion",
      "ratesEffectiveAt",
      "calculationConfigVersion",
    ],
  ],
  ATTENDANCE: [
    "attendanceAnomaly",
    "attendance_anomalies",
    "employeeId",
    ["PENDING"],
    [
      "type",
      "reason",
      "detail",
      "date",
      "fromTime",
      "toTime",
      "rulesVersion",
      "sessionKey",
      "factHash",
      "evidenceState",
      "attachments",
      "manualDeductionDays",
    ],
  ],
  PERFORMANCE: [
    "performanceReview",
    "PerformanceReview",
    "employeeId",
    ["IN_PROGRESS", "DRAFT"],
    [
      "cycleId",
      "period_start",
      "period_end",
      "overall_rating",
      "comments",
      "type",
    ],
  ],
  ASSESSMENT_RELEASE: [
    "assessmentAssignment",
    "AssessmentAssignment",
    "employeeCode",
    ["ACKNOWLEDGED"],
    ["revisionNo", "employeeCode", "profileSnapshot"],
  ],
  DEVELOPMENT: [
    "assessmentIntegration",
    "AssessmentIntegration",
    "employeeCode",
    ["PROPOSED"],
    ["kind", "sequence", "payload"],
  ],
  JOB_DESCRIPTION: [
    "assessmentIntegration",
    "AssessmentIntegration",
    "employeeCode",
    ["OWNER_APPROVED"],
    ["kind", "sequence", "payload"],
  ],
  CATEGORY_CONVERSION: [
    "employeeCategoryConversion",
    "EmployeeCategoryConversion",
    "employeeCode",
    ["REQUESTED"],
    ["category", "effectiveAt", "reason"],
  ],
  NOTICE_CHANGE: [
    "noticePeriodRecord",
    "NoticePeriodRecord",
    "employeeCode",
    null,
    ["payload"],
  ],
};
export const registry = Object.fromEntries(
  Object.entries(definitions).map(
    ([kind, [model, table, owner, pending, fields]]) => [
      kind,
      {
        model,
        table,
        owner,
        pending,
        fields,
        numeric: ![
          "ATTENDANCE_CORRECTION",
          "TIME_CREDIT",
          "TIME_CREDIT_REVOCATION",
          "ASSESSMENT_RELEASE",
          "DEVELOPMENT",
          "JOB_DESCRIPTION",
          "CATEGORY_CONVERSION",
          "NOTICE_CHANGE",
          "SEPARATION_WITHDRAWAL",
          "SETTLEMENT",
        ].includes(kind),
      },
    ],
  ),
);
export function sourceId(kind, ref) {
  const d = registry[kind];
  if (!d) fail("Unknown approval kind", 422);
  const base = String(ref).split("@")[0];
  if (d.numeric && !/^[1-9][0-9]*$/.test(base))
    fail("Invalid request reference", 422);
  if (!d.numeric && !/^[0-9a-f-]{36}$/i.test(base))
    fail("Invalid request reference", 422);
  return d.numeric ? Number(base) : base;
}
const pick = (row, fields) =>
  Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
export async function loadSource(
  tx,
  env,
  kind,
  ref,
  { lock = false, pending = true } = {},
) {
  const d = registry[kind],
    id = sourceId(kind, ref);
  if(lock && kind==='LOAN_WRITEOFF') await lockAttendancePeriod(tx,env.tenantId,true);
  if (lock)
    await tx.$queryRawUnsafe(
      `SELECT id FROM "${d.table}" WHERE "tenantId"=$1::uuid AND id=$2${d.numeric ? "" : "::uuid"} FOR UPDATE`,
      env.tenantId,
      id,
    );
  const row = await tx[d.model].findFirst({
    where: { tenantId: env.tenantId, id },
  });
  if (!row) fail("Request not found", 404);
  const status = row.status ?? row.state;
  if (pending && d.pending && !d.pending.includes(status))
    fail("The source is not ready for approval");
  if (
    ["DEVELOPMENT", "JOB_DESCRIPTION"].includes(kind) &&
    row.kind !== (kind === "DEVELOPMENT" ? "DEVELOPMENT" : "JD")
  )
    fail("Proposal kind does not match", 422);
  if (kind === "SEPARATION_WITHDRAWAL" && !row.withdrawalRequestedAt)
    fail("No separation withdrawal is pending");
  if (kind === "NOTICE_CHANGE" && !row.payload?.pending)
    fail("No notice change is pending");
  const suffix =
    kind === "ASSESSMENT_RELEASE"
      ? row.revisionNo
      : ["NOTICE_CHANGE", "SETTLEMENT"].includes(kind)
        ? row.version
        : kind === "SEPARATION_WITHDRAWAL"
          ? new Date(row.withdrawalRequestedAt).getTime()
          : kind === "ATTENDANCE"
            ? row.factHash
            : null;
  if (pending && suffix !== null && ref !== `${id}@${suffix}`)
    fail("Source revision changed; submit the current revision");
  let who;
  if (d.owner === "employeeCode")
    who = await employee(tx, env.tenantId, row.employeeCode);
  else
    who = await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id: row[d.owner] ?? -1 },
    });
  if (!who?.employee_code)
    fail("The request requires an employee initiator with an employee code");
  const data = pick(row, d.fields);
  if (kind === "NOTICE_CHANGE") data.payload = row.payload.pending;
  if (kind === "SHIFT_SWAP" && row.targetId) {
    const target = await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id: row.targetId },
    });
    if (!target) fail("Swap target is outside this company");
    data.targetCode = target.employee_code;
    delete data.targetId;
  }
  if (kind === "CLAIM")
    data.items = await tx.claimItem.findMany({
      where: { tenantId: env.tenantId, claimId: id },
      orderBy: { id: "asc" },
      select: { name: true, description: true, amount: true, mediaId: true },
    });
  if (kind === "TIMESHEET")
    data.entries = await tx.timeEntry.findMany({
      where: { tenantId: env.tenantId, timesheetId: id },
      orderBy: { id: "asc" },
      select: {
        work_date: true,
        start_time: true,
        end_time: true,
        duration_minutes: true,
        work_type: true,
        entry_type: true,
        note: true,
      },
    });
  if (kind === "PAYROLL")
    data.payslips = await tx.payrollPayslip.findMany({
      where: { tenantId: env.tenantId, payrollRunId: id },
      orderBy: { id: "asc" },
      select: {
        employeeId: true,
        grossAmount: true,
        totalDeductions: true,
        netAmount: true,
        payableDays: true,
        attendanceBasisMinor: true,
        attendancePeriodDays: true,
        earnings: { orderBy: { id: "asc" }, select: { earningTypeId: true, amount: true, description: true } },
        deductions: { orderBy: { id: "asc" }, select: { deductionTypeId: true, amount: true, description: true } },
      },
    });
  if (kind === 'PAYROLL' && pending && await tx.payrollPayslip.count({where:{tenantId:env.tenantId,payrollRunId:id,status:'HOLD'}})) fail('Resolve held payslips before submitting payroll for approval');
  // Keep already-reviewed legacy runs verifiable after this additive upgrade.
  // Recalculation pins a configuration version and opts into the stronger
  // line-item snapshot; new calculations always use that snapshot.
  if (kind === 'PAYROLL' && row.calculationConfigVersion == null) {
    delete data.calculationConfigVersion;
    data.payslips=data.payslips.map(s=>pick(s,['employeeId','grossAmount','totalDeductions','netAmount']));
  }
  if (kind === "ASSESSMENT_RELEASE") {
    const revision = await tx.assessmentRevision.findFirst({
      where: {
        tenantId: env.tenantId,
        assessmentRef: id,
        revisionNo: row.revisionNo,
      },
    });
    if (!revision || revision.state !== "APPROVED")
      fail("Practical review and employee acknowledgment must be completed");
    data.revisionDigest = revision.digest;
  }
  // Numeric employee foreign keys stay internal; business identity uses codes.
  if (kind === "PAYROLL")
    for (const slip of data.payslips) {
      const e = await tx.employee.findFirst({
        where: { tenant_id: env.tenantId, id: slip.employeeId },
      });
      if (!e) fail("Payroll employee is outside this company");
      slip.employeeCode = e.employee_code;
      delete slip.employeeId;
    }
  const snapshot = json({ employeeCode: who.employee_code, ...data });
  return { row, who, definition: d, snapshot, digest: hash(snapshot) };
}
export async function sourceCandidates(tx, env, kind) {
  const kinds = kind ? [kind] : Object.keys(registry),
    candidates = [];
  for (const k of kinds) {
    const d = registry[k];
    const owner =
      d.owner === "employeeCode" ? { in: env.identityCodes } : env.who.id;
    const where = { tenantId: env.tenantId, [d.owner]: owner };
    if (d.pending)
      where[
        [
          "TIME_CREDIT",
          "TIME_CREDIT_REVOCATION",
          "ASSESSMENT_RELEASE",
          "CATEGORY_CONVERSION",
        ].includes(k)
          ? "state"
          : "status"
      ] = { in: d.pending };
    if (["DEVELOPMENT", "JOB_DESCRIPTION"].includes(k))
      where.kind = k === "DEVELOPMENT" ? "DEVELOPMENT" : "JD";
    const rows = await tx[d.model].findMany({
      where,
      orderBy: { id: "desc" },
      take: 100,
    });
    for (const row of rows) {
      if (k === "NOTICE_CHANGE" && !row.payload?.pending) continue;
      if (k === "SEPARATION_WITHDRAWAL" && !row.withdrawalRequestedAt) continue;
      const sourceRef =
        String(row.id) +
        (k === "ASSESSMENT_RELEASE"
          ? `@${row.revisionNo}`
          : ["NOTICE_CHANGE", "SETTLEMENT"].includes(k)
            ? `@${row.version}`
            : k === "SEPARATION_WITHDRAWAL"
              ? `@${new Date(row.withdrawalRequestedAt).getTime()}`
              : k === "ATTENDANCE"
                ? `@${row.factHash}`
                : "");
      const existing = await tx.hrApprovalRequest.findUnique({
        where: {
          tenantId_kind_sourceRef: {
            tenantId: env.tenantId,
            kind: k,
            sourceRef,
          },
        },
      });
      if (!existing)
        candidates.push({
          kind: k,
          sourceRef,
          employeeCode: env.who.employee_code,
          label: row.title || row.reason || row.kind || k,
        });
    }
  }
  return candidates;
}
export async function onSubmit(tx, env, kind, s) {
  if (kind === 'ATTENDANCE_CORRECTION' && ((!s.row.checkIn && !s.row.checkOut) || !s.row.reason?.trim() || !s.row.evidence?.trim() || !s.row.reasonCategory || !s.row.evidenceDate)) fail('Complete the supported missing time, reason category, explanation, evidence reference and source date before submitting.',422);
  if (kind === "TIMESHEET" && !s.snapshot.entries.length)
    fail("Cannot submit an empty timesheet", 422);
  if (
    kind === "ATTENDANCE" &&
    (!s.row.reason?.trim() || s.row.evidenceState !== "ACTIVE")
  )
    fail("An employee explanation and active evidence are required");
  const changes = {
    CLAIM: { status: "SUBMITTED", submittedAt: env.now },
    TIMESHEET: { status: "SUBMITTED", submitted_at: env.now },
    REQUISITION: { status: "PENDING_APPROVAL" },
    ATTENDANCE: { status: "PENDING" },
  }[kind];
  if (changes)
    await tx[s.definition.model].update({
      where: { id: s.row.id },
      data: changes,
    });
}
export async function onReturn(tx, kind, source, target) {
  if (target !== "INITIATOR") return;
  const changes = {
    CLAIM: { status: "NEEDS_INFO" },
    TIMESHEET: { status: "DRAFT" },
    REQUISITION: { status: "DRAFT" },
  }[kind];
  if (changes)
    await tx[source.definition.model].update({
      where: { id: source.row.id },
      data: changes,
    });
}
export async function applyDecision(tx, env, request, s, approved, reason) {
  const { kind } = request,
    row = s.row,
    status = approved ? "APPROVED" : "REJECTED";
  // More specialised execution keeps its existing validations and permissions.
  // The approval binds to this exact source revision, and is consumed by its native action.
  if (
    [
      "ASSESSMENT_RELEASE",
      "DEVELOPMENT",
      "JOB_DESCRIPTION",
      "CATEGORY_CONVERSION",
      "NOTICE_CHANGE",
      "OFFER",
      "SEPARATION_WITHDRAWAL",
      "SETTLEMENT",
    ].includes(kind)
  )
    return "SEPARATE_ACTION";
  await tx.$executeRaw`SELECT set_config('app.hr_approval_finalizing',${kind + ":" + row.id},true)`;
  if (kind === "ATTENDANCE_CORRECTION") {
    const { finalizeCorrectionRequest } = await import('../attendanceCorrectionRequest.service.js');
    await finalizeCorrectionRequest(tx, env, row, approved);
  } else if (kind === "TIME_CREDIT") {
    const { finalizeTimeCredit } =
      await import("../attendanceEvaluation.service.js");
    await finalizeTimeCredit(tx, env, row, approved);
  } else if (kind === "TIME_CREDIT_REVOCATION") {
    if (approved) {
      const { finalizeTimeCreditRevocation } =
        await import("../attendanceEvaluation.service.js");
      await finalizeTimeCreditRevocation(
        {
          tenantId: env.tenantId,
          id: row.id,
          reason,
          actorId: env.who.employee_code,
        },
        tx,
      );
    }
  } else if (kind === "LEAVE") {
    if (approved) {
      if (!row.leavePolicyId)
        fail("HR must assign the leave policy before employee submission");
      await assertAttendancePeriodOpen(
        tx,
        env.tenantId,
        row.startDate,
        row.endDate,
      );
      await tx.leaveBalance.upsert({
        where: {
          employeeId_leavePolicyId: {
            employeeId: row.employeeId,
            leavePolicyId: row.leavePolicyId,
          },
        },
        create: {
          tenantId: env.tenantId,
          employeeId: row.employeeId,
          leavePolicyId: row.leavePolicyId,
          balance: -row.totalDays,
        },
        update: { balance: { decrement: row.totalDays }, lastUpdated: env.now },
      });
      const { createLeaveAttendanceRecords, upsertLegacyLeaveMirror } =
        await import("../leave.service.js");
      await createLeaveAttendanceRecords(row, tx);
      await upsertLegacyLeaveMirror(row, tx);
    }
    await tx.leaveRequestApproval.create({
      data: {
        tenantId: env.tenantId,
        leaveRequestId: row.id,
        approverId: env.who.id,
        createdById: env.who.id,
        approverRole: "MANAGEMENT",
        decision: status,
        comments: reason,
      },
    });
    await tx.leaveRequest.update({ where: { id: row.id }, data: { status } });
    await enqueueHrDomainEvent(tx, {
      tenantId: env.tenantId,
      actorId: env.who.employee_code,
      eventName: `hr.leave.${approved ? "approved" : "rejected"}.v1`,
      aggregateType: "LeaveRequest",
      aggregateId: row.id,
      payload: {
        employeeCode: s.who.employee_code,
        requestRef: String(row.id),
        status,
      },
    });
  } else if (kind === "OVERTIME") {
    if (approved) {
      await assertAttendancePeriodOpen(tx, env.tenantId, row.date, row.date);
      const shift = await tx.shiftAssignment.findFirst({
        where: {
          tenantId: env.tenantId,
          employeeId: row.employeeId,
          date: row.date,
        },
        orderBy: { id: "desc" },
      });
      if (!shift) fail("Configure the roster before approving overtime");
      await tx.shiftAssignment.update({
        where: { id: shift.id },
        data: { overtimeHours: row.hours },
      });
    }
    await tx.overtimeRequest.update({
      where: { id: row.id },
      data: { status, approverId: env.who.id, decidedAt: env.now },
    });
  } else if (kind === "CLAIM")
    await tx.reimbursementClaim.update({
      where: { id: row.id },
      data: {
        status,
        approvedById: approved ? env.who.id : null,
        approvedAt: approved ? env.now : null,
        rejectedReason: approved ? null : reason,
      },
    });
  else if (kind === "LOAN_WRITEOFF") {
    if (approved) {
      await lockAttendancePeriod(tx,env.tenantId,true);
      const current=await tx.loan.findFirst({where:{id:row.id,tenantId:env.tenantId}});
      if(current?.outstandingMinor!==row.outstandingMinor || current?.status!==row.status) fail('Loan balance changed; refresh the write-off request');
      await assertNoPayrollLoanReservation(tx,env.tenantId,row.id);
      await tx.loan.update({
        where: { id: row.id },
        data: { status: "WRITTEN_OFF", outstandingMinor: 0 },
      });
    }
  } else if (kind === "LOAN")
    await tx.loan.update({
      where: { id: row.id },
      data: {
        status: approved ? "ACTIVE" : "REJECTED",
        approvedById: approved ? env.who.id : null,
      },
    });
  else if (kind === "TIMESHEET") {
    await tx.timeApproval.create({
      data: {
        tenantId: env.tenantId,
        timesheetId: row.id,
        approverId: env.who.id,
        decision: status,
        comments: reason,
      },
    });
    await tx.timesheet.update({
      where: { id: row.id },
      data: { status, approved_at: approved ? env.now : null },
    });
  } else if (kind === "SHIFT_SWAP")
    await tx.shiftSwapRequest.update({
      where: { id: row.id },
      data: { status, approverId: env.who.id, decidedAt: env.now },
    });
  else if (kind === "GOAL")
    await tx.goal.update({
      where: { id: row.id },
      data: { status, approvedById: env.who.id },
    });
  else if (kind === "REQUISITION") {
    await tx.requisitionApproval.create({
      data: {
        tenantId: env.tenantId,
        requisitionId: row.id,
        approverId: env.who.id,
        status,
        comments: reason,
        decidedAt: env.now,
      },
    });
    await tx.jobRequisition.update({
      where: { id: row.id },
      data: { status, approvedById: approved ? env.who.id : null },
    });
  } else if (kind === "PAYROLL") {
    await tx.payrollRun.update({
      where: { id: row.id },
      data: {
        status,
        approvedBy: approved ? env.who.id : null,
        approvedAt: approved ? env.now : null,
      },
    });
    await tx.payrollAuditLog.create({
      data: {
        tenantId: env.tenantId,
        payrollRunId: row.id,
        action: "PAYROLL_" + status,
        details: `Management ${env.who.employee_code}: ${reason}`,
      },
    });
  } else if (kind === "PERFORMANCE") {
    // PERF-P0 (E-02/E-03): hr_approval_guard (20261015120000) makes this adapter
    // the only path to a FINALIZED review; the finalized domain event rides the
    // same transaction through the outbox (E-03).
    const review = await tx.performanceReview.update({
      where: { id: row.id },
      data: { status: approved ? "FINALIZED" : "DRAFT" },
    });
    if (approved)
      await enqueueHrDomainEvent(
        tx,
        performanceReviewFinalizedEvent(review, {
          actorId: env.who.employee_code,
          correlationId: env.ctx?.correlationId,
        }),
      );
  } else if (kind === "ATTENDANCE") {
    if (row.rulesVersion !== 2)
      fail(
        "Re-evaluate this legacy attendance case under the current evidence rules",
      );
    const { finalizeRuleCase } = await import("../attendanceRules.service.js");
    await finalizeRuleCase(
      {
        user: { ...env.ctx.user, employeeId: env.who.id },
        anomalyId: row.id,
        version: row.workflowVersion,
        decision: status,
        comment: reason,
      },
      tx,
    );
  }
  return "APPLIED";
}
// Native specialist actions must call this inside their transaction before effects.
export async function requireApproval(
  tx,
  tenantId,
  kind,
  sourceRef,
  approved = true,
) {
  const row = await tx.hrApprovalRequest.findUnique({
    where: {
      tenantId_kind_sourceRef: { tenantId, kind, sourceRef: String(sourceRef) },
    },
  });
  if (!row || row.stage !== (approved ? "APPROVED" : "REJECTED"))
    fail(
      "Complete the employee, manager, HR and Management approval workflow in HR Approval Centre",
    );
  await tx.$queryRaw`SELECT id FROM "HrApprovalRequest" WHERE "tenantId"=${tenantId}::uuid AND id=${row.id}::uuid FOR UPDATE`;
  const source = await loadSource(tx, { tenantId }, kind, String(sourceRef), {
    lock: true,
  });
  if (source.digest !== row.sourceHash)
    fail("The approved source changed; a fresh approval is required");
  await tx.$executeRaw`SELECT set_config('app.hr_approval_finalizing',${kind + ":" + source.row.id},true)`;
  return row;
}

// Used only inside the native action's transaction. If its domain validation or
// write fails, this execution marker rolls back with it.
export async function consumeApproval(tx, tenantId, kind, sourceRef, approved = true) {
  const row = await requireApproval(tx, tenantId, kind, sourceRef, approved);
  await tx.hrApprovalRequest.update({where:{id:row.id},data:{execution:'APPLIED'}});
  return row;
}
