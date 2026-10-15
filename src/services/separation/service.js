import { consumeApproval } from '../approval/adapters.js';
import { hrRevertTarget } from "@trusoft/contracts/hr-approval-rules";
import {
  CreateSeparation,
  EditSeparation,
  RevertSeparation,
  PolicyCommand,
  SeparationAction,
  ManagerRecommendation,
  HrVerification,
  ManagementDecision,
  NoticeAction,
} from "@trusoft/contracts/employment";
import {
  run,
  fail,
  employee,
  policy,
  permit,
  isHr,
  checkVersion,
  result,
  view,
  authorizedSeparation,
  managerOnly,
  approverOnly,
  change,
  touch,
  event,
  createTask,
  updateTask,
  json,
  notify,
  audit,
  ownsCode,
} from "./base.js";
import { noticeCalculation, companyDate, clearanceComplete } from "./rules.js";
import {
  generateWorkstreams,
  generateDocument,
  assertHandoverComplete,
  assertExitComplete,
} from "./workstreams.js";
import { separationView } from "./read.js";

export const configureSeparation = (raw) => {
  const input = PolicyCommand.parse(raw);
  return run(
    input,
    "hr.separation.manage",
    async (tx, env) => {
      if (input.employeeCode !== env.who.employee_code)
        fail("Configuration actor must be your employee code", 403);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${env.tenantId + ":separation-policy"},0))`;
      const old = await tx.separationPolicy.findUnique({
        where: { tenantId: env.tenantId },
      });
      checkVersion(old || { version: 0 }, input.expectedVersion);
      const codes = new Set([
        ...input.policy.hrCodes,
        input.policy.itOwnerCode,
        input.policy.payrollOwnerCode,
        ...input.policy.authority.flatMap((a) => a.approverCodes),
        ...input.policy.clearanceDepartments.flatMap((d) => [
          d.ownerCode,
          ...d.signerCodes,
        ]),
      ]);
      for (const code of codes) await employee(tx, env.tenantId, code);
      const row = await tx.separationPolicy.upsert({
        where: { tenantId: env.tenantId },
        create: {
          tenantId: env.tenantId,
          policy: input.policy,
          actorCode: env.who.employee_code,
        },
        update: {
          policy: input.policy,
          actorCode: env.who.employee_code,
          version: { increment: 1 },
        },
      });
      return result(env, view(row, "POLICY", row.policy));
    },
    "CONFIGURE",
  );
};

export const createSeparation = (raw) => {
  const input = CreateSeparation.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      checkVersion({ version: 0 }, input.expectedVersion);
      const e = await employee(tx, env.tenantId, input.employeeCode),
        p = (await policy(tx, env.tenantId)).value;
      const self = e.employee_code === env.who.employee_code,
        manager = e.managerId === env.who.id;
      const rule = p.typeRules.find((t) => t.type === input.type);
      const role = self
        ? "SELF"
        : isHr(env)
          ? "HR"
          : manager
            ? "MANAGER"
            : null;
      if (!rule?.initiators.includes(role))
        fail("This separation type cannot be initiated by your role", 403);
      if (role === "SELF") {
        permit(env, "hr.separation.self");
        if (input.type !== "RESIGNATION")
          fail("Employees may initiate only their own resignation", 403);
      }
      if (role === "MANAGER") permit(env, "hr.separation.manager");
      if (
        /inactive|terminated|exited|separated/i.test(
          `${e.status} ${e.employement_status}`,
        )
      )
        fail("Employee is already inactive", 409);
      if (!e.employeeCategory)
        fail("HR must verify the employee category before separation", 409);
      const grade = e.gradeLevelId
        ? await tx.gradeLevel.findFirst({
            where: { tenantId: env.tenantId, id: e.gradeLevelId },
          })
        : null;
      const gradeCode = grade?.name;
      if (
        !gradeCode ||
        !p.authority.some(
          (a) => a.category === e.employeeCategory && a.gradeCode === gradeCode,
        )
      )
        fail("Configure the category and grade authority matrix first", 409);
      const managerRow = e.managerId
        ? await tx.employee.findFirst({
            where: { tenant_id: env.tenantId, id: e.managerId },
          })
        : null;
      if (!managerRow?.employee_code)
        fail("A verified direct manager is required", 409);
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id=${e.id} FOR UPDATE`;
      if (
        await tx.separation.findFirst({
          where: {
            tenantId: env.tenantId,
            employeeCode: e.employee_code,
            state: { notIn: ["EXIT_COMPLETED", "WITHDRAWN", "CANCELLED"] },
          },
        })
      )
        fail("An open separation already exists", 409);
      if (new Date(input.proposedLastWorkingAt) < env.now)
        fail("Proposed last working day must not be in the past");
      const row = await tx.separation.create({
        data: {
          tenantId: env.tenantId,
          employeeCode: e.employee_code,
          type: input.type,
          reasonCode: input.reasonCode,
          reason: input.reason,
          proposedLastWorkingAt: new Date(input.proposedLastWorkingAt),
          createdByCode: env.who.employee_code,
          managerCode: managerRow.employee_code,
          category: e.employeeCategory,
          gradeCode,
          policySnapshot: json(p),
          documents: input.documents,
        },
      });
      await audit(tx, env, row, "DRAFT_CREATED", input.reason);
      await notify(tx, env, row, "DRAFT_CREATED", `draft:${row.id}`);
      return result(env, separationView(row, env));
    },
    "CREATE",
  );
};

export const separationAction = (raw) => {
  const input = SeparationAction.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      if (input.action === "SUBMIT") {
        if (!ownsCode(env, s.createdByCode))
          fail("Only the employee initiator may submit", 403);
        if (s.state !== "DRAFT") fail("Only a draft can be submitted", 409);
        const rule = s.policySnapshot.typeRules.find((t) => t.type === s.type);
        if (
          rule.requiredDocumentKinds.some(
            (k) => !s.documents.some((d) => d.kind === k),
          )
        )
          fail("Required supporting documents are missing");
        const e = await employee(tx, env.tenantId, s.employeeCode);
        const requiredDays =
          rule.noticeTreatment === "NONE"
            ? 0
            : (e.contractNoticeDays ??
              s.policySnapshot.noticeByGrade.find(
                (n) => n.category === s.category && n.gradeCode === s.gradeCode,
              )?.days);
        if (requiredDays === undefined)
          fail(
            "Configure contractual or grade notice days before submission",
            409,
          );
        const payload = noticeCalculation({
          submittedOn: companyDate(env.now, s.policySnapshot.timeZone),
          lastWorkingOn: companyDate(
            s.proposedLastWorkingAt,
            s.policySnapshot.timeZone,
          ),
          requiredDays,
        });
        const priorNotice = await tx.noticePeriodRecord.findFirst({
          where: { tenantId: env.tenantId, separationRef: s.id },
        });
        if (priorNotice)
          await updateTask(tx, env, "noticePeriodRecord", priorNotice, {
            payload,
            dueAt: s.proposedLastWorkingAt,
          });
        else
          await createTask(
            tx,
            env,
            s,
            "noticePeriodRecord",
            "NOTICE",
            payload,
            s.policySnapshot.hrCodes[0],
            s.proposedLastWorkingAt,
          );
        s = await change(
          tx,
          env,
          s,
          "SUBMITTED",
          "SUBMITTED",
          input.reason,
          { submittedAt: env.now },
          "hr.separation.submitted.v1",
        );
        s = await change(
          tx,
          env,
          s,
          "MANAGER_REVIEW",
          "MANAGER_REVIEW",
          "Submitted for direct manager review",
        );
      } else if (input.action === "WITHDRAW") {
        permit(env, "hr.separation.self");
        if (
          s.employeeCode !== env.who.employee_code ||
          s.type !== "RESIGNATION"
        )
          fail("Only the employee may withdraw their own resignation", 403);
        if (s.approvedAt) {
          if (
            !s.policySnapshot.typeRules.find((t) => t.type === s.type)
              .allowPostApprovalWithdrawal
          )
            fail("Policy does not allow withdrawal after approval", 403);
          s = await touch(tx, env, s, "WITHDRAWAL_REQUESTED", input.reason, {
            withdrawalRequestedAt: env.now,
          });
          await notify(
            tx,
            env,
            s,
            "WITHDRAWAL_REQUESTED",
            `withdrawal:${s.id}:${s.version}`,
          );
        } else
          s = await change(
            tx,
            env,
            s,
            "WITHDRAWN",
            "WITHDRAWN",
            input.reason,
            {},
            "hr.separation.withdrawn.v1",
          );
      } else if (input.action === "CANCEL") {
        permit(env, "hr.separation.manage");
        s = await change(
          tx,
          env,
          s,
          "CANCELLED",
          "CANCELLED",
          input.reason,
          {},
          "hr.separation.cancelled.v1",
        );
      } else if (input.action === "START_HANDOVER") {
        if (!isHr(env)) await managerOnly(tx, env, s);
        s = await change(
          tx,
          env,
          s,
          "HANDOVER_IN_PROGRESS",
          "HANDOVER_STARTED",
          input.reason,
        );
      } else if (input.action === "START_CLEARANCE") {
        permit(env, "hr.separation.verify");
        await assertHandoverComplete(tx, env, s);
        s = await change(
          tx,
          env,
          s,
          "CLEARANCE",
          "CLEARANCE_STARTED",
          input.reason,
        );
      } else if (input.action === "COMPLETE_EXIT") {
        permit(env, "hr.separation.manage");
        if (typeof input.rehireEligible !== "boolean")
          fail("Record rehire eligibility");
        if (!s.lastWorkingAt || s.lastWorkingAt > env.now)
          fail("Exit cannot be completed before the last working time", 409);
        await assertExitComplete(tx, env, s);
        s = await change(
          tx,
          env,
          s,
          "EXIT_COMPLETED",
          "EXIT_COMPLETED",
          input.reason,
          { completedAt: env.now, rehireEligible: input.rehireEligible },
          "hr.separation.exit_completed.v1",
        );
        const e = await employee(tx, env.tenantId, s.employeeCode);
        await tx.employee.update({
          where: { id: e.id },
          data: {
            status: "Separated",
            employement_status: "Separated",
            separatedAt: s.lastWorkingAt,
            rehireEligible: input.rehireEligible,
            version: { increment: 1 },
          },
        });
        await tx.assessmentCapability.updateMany({
          where: { tenantId: env.tenantId, employeeCode: s.employeeCode },
          data: { status: "EXPIRED" },
        });
        await tx.assessmentIdentity.updateMany({
          where: { tenantId: env.tenantId, employeeCode: s.employeeCode },
          data: { active: false },
        });
        await event(tx, env, s, "hr.employee.separated.v1");
        await generateDocument(tx, env, s, "EXPERIENCE");
      }
      return result(env, separationView(s, env));
    },
    "ACTION",
  );
};

export const recommendSeparation = (raw) => {
  const input = ManagerRecommendation.parse(raw);
  return run(
    input,
    "hr.separation.manager",
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      await managerOnly(tx, env, s);
      if (s.state !== "MANAGER_REVIEW")
        fail("Not awaiting manager review", 409);
      await employee(tx, env.tenantId, input.interimOwnerCode);
      if (input.replacementCode)
        await employee(tx, env.tenantId, input.replacementCode);
      if (
        [input.replacementCode, input.interimOwnerCode].includes(s.employeeCode)
      )
        fail("The leaver cannot be the receiving owner");
      if (
        input.requisitionRef &&
        !(await tx.jobRequisition.findFirst({
          where: { tenantId: env.tenantId, id: Number(input.requisitionRef) },
        }))
      )
        fail("Recruitment requisition not found", 404);
      if (input.recommendation === "DEFER" && !input.deferredUntil)
        fail("A deferral date is required");
      const {
        requestKey,
        expectedVersion,
        separationRef,
        employeeCode,
        ...recommendation
      } = input;
      s = await change(
        tx,
        env,
        s,
        "HR_VERIFICATION",
        "MANAGER_RECOMMENDED",
        input.reason,
        { recommendation, managerCode: env.who.employee_code },
      );
      return result(env, separationView(s, env));
    },
    "RECOMMEND",
  );
};
export const verifySeparation = (raw) => {
  const input = HrVerification.parse(raw);
  return run(
    input,
    "hr.separation.verify",
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      if (s.employeeCode === env.who.employee_code)
        fail("An independent HR officer must verify", 403);
      s = await change(
        tx,
        env,
        s,
        "MANAGEMENT_DECISION",
        "HR_VERIFIED",
        "HR verification recorded",
        { verification: input.findings, verifiedByCode: env.who.employee_code },
      );
      return result(env, separationView(s, env));
    },
    "VERIFY",
  );
};
export const decideSeparation = (raw) => {
  const input = ManagementDecision.parse(raw);
  return run(
    input,
    "hr.separation.approve",
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      await approverOnly(tx, env, s);
      if (input.decision.endsWith("_WITHDRAWAL")) {
        if (!s.withdrawalRequestedAt)
          fail("No withdrawal request is pending", 409);
        await consumeApproval(tx, env.tenantId, "SEPARATION_WITHDRAWAL", `${s.id}@${new Date(s.withdrawalRequestedAt).getTime()}`, input.decision === "APPROVE_WITHDRAWAL");
        if (input.decision === "APPROVE_WITHDRAWAL")
          s = await change(
            tx,
            env,
            s,
            "WITHDRAWN",
            "WITHDRAWN",
            input.reason,
            { withdrawalRequestedAt: null },
            "hr.separation.withdrawn.v1",
          );
        else
          s = await touch(tx, env, s, "WITHDRAWAL_REJECTED", input.reason, {
            withdrawalRequestedAt: null,
          });
      } else {
        if (s.state !== "MANAGEMENT_DECISION" || !s.verification)
          fail("Complete manager and HR review first", 409);
        if (s.deferredUntil)
          fail("Decision is deferred until its scheduled review", 409);
        if (input.decision === "REJECT")
          s = await change(
            tx,
            env,
            s,
            "CANCELLED",
            "REJECTED",
            input.reason,
            {},
            "hr.separation.rejected.v1",
          );
        else if (input.decision === "DEFER") {
          if (
            !input.deferredUntil ||
            input.deferredUntil <=
              companyDate(env.now, s.policySnapshot.timeZone)
          )
            fail("Deferral date must be in the future");
          s = await touch(tx, env, s, "DEFERRED", input.reason, {
            deferredUntil: new Date(input.deferredUntil + "T00:00:00Z"),
          });
          await event(tx, env, s, "hr.separation.deferred.v1");
          await notify(tx, env, s, "DEFERRED", `deferred:${s.id}:${s.version}`);
        } else {
          const lastWorkingAt = new Date(
            input.lastWorkingAt || s.proposedLastWorkingAt,
          );
          if (lastWorkingAt < env.now)
            fail("Last working time cannot be in the past");
          const notice = await tx.noticePeriodRecord.findFirst({
            where: { tenantId: env.tenantId, separationRef: s.id },
          });
          const calculated = noticeCalculation({
            ...notice.payload,
            lastWorkingOn: companyDate(
              lastWorkingAt,
              s.policySnapshot.timeZone,
            ),
          });
          await updateTask(tx, env, "noticePeriodRecord", notice, {
            payload: {
              ...calculated,
              shortfallDisposition: calculated.shortfallDays
                ? "PENDING_NOTICE_ACTION"
                : "COMPLIANT",
            },
            dueAt: lastWorkingAt,
          });
          s = await change(
            tx,
            env,
            s,
            "APPROVED",
            "APPROVED",
            input.reason,
            { approvedAt: env.now, lastWorkingAt },
            "hr.separation.approved.v1",
          );
          await generateWorkstreams(tx, env, s);
          await generateDocument(
            tx,
            env,
            s,
            s.type === "RESIGNATION" ? "ACCEPTANCE" : "TERMINATION",
          );
          await event(tx, env, s, "hr.separation.clawback_requested.v1");
          s = await change(
            tx,
            env,
            s,
            "NOTICE_PERIOD",
            "NOTICE_STARTED",
            "Notice tracking started",
            {},
            "hr.separation.notice_started.v1",
          );
        }
      }
      return result(env, separationView(s, env));
    },
    "DECIDE",
  );
};

export const noticeAction = (raw) => {
  const input = NoticeAction.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      if (
        !["NOTICE_PERIOD", "HANDOVER_IN_PROGRESS", "CLEARANCE"].includes(
          s.state,
        )
      )
        fail("Notice actions require an approved active separation", 409);
      const settled = await tx.finalSettlementSheet.findFirst({
        where: {
          tenantId: env.tenantId,
          separationRef: s.id,
          status: { in: ["HANDED_OFF", "COMPLETED"] },
        },
      });
      if (settled) fail("Notice is locked after payroll handoff", 409);
      const n = await tx.noticePeriodRecord.findFirst({
        where: { tenantId: env.tenantId, separationRef: s.id },
      });
      checkVersion(n, input.noticeVersion);
      let payload = { ...n.payload },
        data = {};
      if (input.action.startsWith("REQUEST_")) {
        if (s.employeeCode !== env.who.employee_code && !isHr(env))
          fail("Only the employee or HR may request a notice change", 403);
        if (payload.pending) fail("A notice request is awaiting decision", 409);
        if (
          input.action === "REQUEST_EARLY_RELEASE" &&
          (!input.lastWorkingAt ||
            new Date(input.lastWorkingAt) < env.now ||
            new Date(input.lastWorkingAt) >= s.lastWorkingAt)
        )
          fail(
            "Early release must be in the future and before the current last working time",
          );
        if (input.action === "REQUEST_BUYOUT" && !(input.days > 0))
          fail("Specify buyout days");
        payload.pending = {
          action: input.action,
          days: input.days ?? 0,
          lastWorkingAt: input.lastWorkingAt ?? null,
          reason: input.reason,
          requestedByCode: env.who.employee_code,
        };
      } else {
        await approverOnly(tx, env, s);
        if (!payload.pending) fail("No notice request is pending", 409);
        await consumeApproval(tx, env.tenantId, "NOTICE_CHANGE", `${n.id}@${n.version}`, input.action === "APPROVE");
        if (ownsCode(env, payload.pending.requestedByCode))
          fail("Notice changes require an independent approver", 403);
        if (input.action === "APPROVE") {
          const p = payload.pending;
          if (p.action === "REQUEST_BUYOUT") payload.buyoutDays = p.days;
          if (p.action === "REQUEST_EARLY_RELEASE") {
            data.lastWorkingAt = new Date(p.lastWorkingAt);
            payload.lastWorkingOn = companyDate(
              data.lastWorkingAt,
              s.policySnapshot.timeZone,
            );
            payload.waivedDays = Math.max(
              0,
              payload.requiredDays -
                Math.floor(
                  (new Date(payload.lastWorkingOn) -
                    new Date(payload.submittedOn)) /
                    86400000,
                ) -
                (payload.buyoutDays || 0),
            );
          }
          if (p.action === "REQUEST_GARDEN_LEAVE") payload.gardenLeave = true;
          payload = {
            ...payload,
            ...noticeCalculation(payload),
            approvedByCode: env.who.employee_code,
          };
        }
        payload = {
          ...payload,
          lastDecision: {
            action: input.action,
            reason: input.reason,
            byCode: env.who.employee_code,
            at: env.now.toISOString(),
          },
          pending: null,
        };
      }
      await updateTask(tx, env, "noticePeriodRecord", n, {
        payload: json(payload),
        ...(data.lastWorkingAt ? { dueAt: data.lastWorkingAt } : {}),
      });
      s = await touch(tx, env, s, input.action, input.reason, data);
      if (data.lastWorkingAt) {
        for (const model of [
          "accessRevocationTask",
          "clearanceItem",
          "knowledgeTransferItem",
          "assetHandoverItem",
          "replacementPlan",
          "replacementSession",
        ])
          await tx[model].updateMany({
            where: {
              tenantId: env.tenantId,
              separationRef: s.id,
              status: { not: "COMPLETED" },
            },
            data: { dueAt: data.lastWorkingAt, version: { increment: 1 } },
          });
        await event(tx, env, s, "hr.separation.updated.v1");
      }
      await notify(tx, env, s, input.action, `notice:${s.id}:${s.version}`);
      return result(env, separationView(s, env));
    },
    "NOTICE",
  );
};

export const editSeparation = (raw) => {
  const input = EditSeparation.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      if (s.state !== "DRAFT" || !ownsCode(env, s.createdByCode))
        fail("Only the initiator may edit a draft or reverted request", 403);
      if (new Date(input.proposedLastWorkingAt) <= env.now)
        fail("Proposed last working time must be in the future");
      s = await touch(tx, env, s, "DRAFT_EDITED", input.reason, {
        proposedLastWorkingAt: new Date(input.proposedLastWorkingAt),
        reasonCode: input.reasonCode,
        reason: input.reason,
        documents: input.documents,
        recommendation: null,
        verification: null,
        verifiedByCode: null,
        deferredUntil: null,
      });
      return result(env, separationView(s, env));
    },
    "EDIT",
  );
};
export const revertSeparation = (raw) => {
  const input = RevertSeparation.parse(raw);
  return run(
    input,
    null,
    async (tx, env) => {
      let s = await authorizedSeparation(tx, env, input, { lock: true });
      let stage;
      if (s.state === "MANAGER_REVIEW") {
        await managerOnly(tx, env, s);
        stage = "LINE_MANAGER";
      } else if (s.state === "HR_VERIFICATION") {
        permit(env, "hr.separation.verify");
        if (s.employeeCode === env.who.employee_code)
          fail("Independent HR verification is required", 403);
        stage = "HR";
      } else if (s.state === "MANAGEMENT_DECISION") {
        await approverOnly(tx, env, s);
        stage = "MANAGEMENT";
      } else fail("Only an active review stage may revert a request", 409);
      const to = hrRevertTarget(stage) === "HR" ? "HR_VERIFICATION" : "DRAFT";
      s = await change(
        tx,
        env,
        s,
        to,
        "REVERTED",
        input.reason,
        {
          verification: null,
          verifiedByCode: null,
          deferredUntil: null,
          ...(to === "DRAFT" ? { recommendation: null } : {}),
        },
        "hr.separation.reverted.v1",
      );
      return result(env, separationView(s, env));
    },
    "REVERT",
  );
};
