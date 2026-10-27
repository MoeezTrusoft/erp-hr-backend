import { consumeApproval } from '../approval/adapters.js';
import { z } from "zod";
import { AssessmentRef } from "@trusoft/contracts/assessment";
import { EmployeeCode } from "@trusoft/contracts/assessment";
import { planningSnapshotFor } from "./planning.js";
import { matchPracticeCandidate } from "./development-matching.js";
import { appraisalSummary } from "./appraisal-summary.js";
import {
  run,
  config,
  identity,
  fail,
  audit,
  event,
  hash,
  json,
} from "./base.js";

export async function publishDownstream(tx, env, a, revision, snap, sequence) {
  const cfg = await config(tx, env.tenantId);
  if (
    !["HR_INTEGRATION", "PM_SHADOW", "CONTROLLED", "AUTOMATIC"].includes(
      cfg.policy.stage,
    )
  )
    return;
  const employee = await identity(tx, env.tenantId, a.employeeCode);
  const previousAssignments = await tx.assessmentAssignment.findMany({
    where: { tenantId: env.tenantId, employeeCode: a.employeeCode },
    select: { id: true },
  });
  const previous = await tx.assessmentRevision.findFirst({
    where: {
      tenantId: env.tenantId,
      assessmentRef: { in: previousAssignments.map((r) => r.id) },
      state: "PUBLISHED",
      id: { not: revision.id },
      sequence: { lt: sequence },
    },
    orderBy: { sequence: "desc" },
  });
  const evidence = await tx.assessmentEvidence.findMany({
    where: {
      tenantId: env.tenantId,
      id: { in: snap.evidenceManifest.map((e) => e.ref) },
    },
  });
  const restrictions = await tx.assessmentRestriction.findMany({
    where: {
      tenantId: env.tenantId,
      employeeCode: a.employeeCode,
      liftedAt: null,
    },
  });
  const summary = appraisalSummary({
    assignment: a,
    revision,
    snapshot: snap,
    previous,
    evidence,
    restrictions,
    now: env.now,
  });
  const cycles = await tx.performanceCycle.findMany({
    where: {
      tenantId: env.tenantId,
      start_date: { lte: env.now },
      end_date: { gte: a.createdAt },
    },
  });
  for (const cycle of cycles) {
    const finalized = await tx.performanceReview.findFirst({
      where: {
        tenantId: env.tenantId,
        employeeId: employee.employeeRowId,
        cycleId: cycle.id,
        status: "FINALIZED",
      },
    });
    await tx.assessmentAppraisalInput.upsert({
      where: {
        tenantId_employeeCode_cycleId_revisionRef: {
          tenantId: env.tenantId,
          employeeCode: a.employeeCode,
          cycleId: cycle.id,
          revisionRef: revision.id,
        },
      },
      create: {
        tenantId: env.tenantId,
        employeeCode: a.employeeCode,
        cycleId: cycle.id,
        revisionRef: revision.id,
        amendment: !!finalized,
        content: json({
          ...summary,
          sequence,
        }),
      },
      update: {},
    });
  }
  for (const o of snap.observations)
    for (const d of o.dimensions) {
      const requirement = a.profileSnapshot.requirements.find(
        (r) => r.taskCode === o.taskCode,
      );
      const target =
        requirement[
          { K: "requiredK", S: "requiredS", V: "targetV" }[d.dimension]
        ];
      if (target == null || d.status === "NOT_APPLICABLE") continue;
      const gapType =
        d.status === "PENDING" ? "EVIDENCE_GAP" : "CAPABILITY_GAP";
      const baseKey = `${a.employeeCode}:${o.taskCode}:${o.taskVersion}:${d.dimension}`;
      const key = `${baseKey}:${gapType}`;
      const actions = await tx.assessmentIntegration.findMany({
        where: {
          tenantId: env.tenantId,
          kind: "DEVELOPMENT",
          key: {
            in: [
              baseKey,
              `${baseKey}:EVIDENCE_GAP`,
              `${baseKey}:CAPABILITY_GAP`,
            ],
          },
        },
      });
      const old = actions.find((r) => r.key === key);
      if (d.status === "RATED") {
        for (const old of actions.filter(
          (r) =>
            !["CLOSED_BY_EVIDENCE", "CANCELLED", "REJECTED"].includes(
              r.status,
            ) &&
            (d.score >= target || r.payload.gapType === "EVIDENCE_GAP"),
        )) {
          await tx.assessmentIntegration.update({
            where: { id: old.id },
            data: {
              status: "CLOSED_BY_EVIDENCE",
              sourceRef: revision.id,
              sequence,
            },
          });
          if (old.targetRef) {
            await tx.$executeRaw`SELECT set_config('app.assessment_development_closure', ${revision.id}, true)`;
            await tx.developmentPlanItem.updateMany({
              where: { tenantId: env.tenantId, id: Number(old.targetRef) },
              data: { status: "COMPLETED", completedAt: env.now },
            });
          }
          await event(tx, env, "hr.development.closed_by_evidence.v1", old.id, {
            employeeCode: a.employeeCode,
            taskCode: o.taskCode,
            dimension: d.dimension,
            revisionRef: revision.id,
          });
        }
      }
      if (d.status === "RATED" && d.score >= target) continue;
      const payload = {
        ...(old?.payload || {}),
        taskCode: o.taskCode,
        taskVersion: o.taskVersion,
        dimension: d.dimension,
        target,
        actual: d.score,
        gapType,
        managerCode: employee.managerCode,
        suggestedLearning:
          cfg.learningMappings?.filter(
            (m) => m.taskCode === o.taskCode && m.dimension === d.dimension,
          ) || [],
        requiresManagerApproval: true,
        reassessmentRequired: true,
        triggeringRevisions: [
          ...new Set([
            ...(old?.payload?.triggeringRevisions || []),
            revision.id,
          ]),
        ],
      };
      const result = await tx.assessmentIntegration.upsert({
        where: {
          tenantId_kind_key: {
            tenantId: env.tenantId,
            kind: "DEVELOPMENT",
            key,
          },
        },
        create: {
          tenantId: env.tenantId,
          employeeCode: a.employeeCode,
          kind: "DEVELOPMENT",
          key,
          sourceRef: revision.id,
          status: "PROPOSED",
          payload,
          sequence,
        },
        update: {
          payload,
          sourceRef: revision.id,
          sequence,
          ...(old?.status === "CLOSED_BY_EVIDENCE"
            ? { status: "PROPOSED", targetRef: null }
            : {}),
        },
      });
      if (!old || old.status === "CLOSED_BY_EVIDENCE")
        await event(tx, env, "hr.development.created.v1", result.id, {
          employeeCode: a.employeeCode,
          developmentRef: result.id,
          taskCode: o.taskCode,
          dimension: d.dimension,
        });
    }
}
export const IntegrationCommand = z
  .object({
    ref: AssessmentRef,
    expectedSequence: z.number().int().nonnegative(),
    action: z.enum([
      "APPROVE_DEVELOPMENT",
      "REJECT",
      "OWNER_APPROVE_JD",
      "PUBLISH_JD",
    ]),
    declaration: z.string().min(10),
    dueAt: z.string().datetime().optional(),
    courseRef: z.string().optional(),
    workOpportunityRef: AssessmentRef.optional(),
    supervisorCode: EmployeeCode.optional(),
  })
  .strict();
export async function decideIntegration(raw) {
  const input = IntegrationCommand.parse(raw);
  return run(
    input.action.includes("JD")
      ? "hr.assessment_jd.approve"
      : "hr.assessment_development.approve",
    async (tx, env) => {
      const row = await tx.assessmentIntegration.findFirst({
        where: { tenantId: env.tenantId, id: input.ref },
      });
      if (!row) fail("NOT_FOUND", "Proposal not found", 404);
      if (row.sequence !== input.expectedSequence)
        fail("STALE_VERSION", "Proposal changed", 409);
      const employee = await identity(tx, env.tenantId, row.employeeCode);
      if (row.employeeCode === env.who.employeeCode)
        fail("SELF_APPROVAL", "A separate approver is required", 403);
      if (["APPROVE_DEVELOPMENT","PUBLISH_JD","REJECT"].includes(input.action))
        await consumeApproval(tx, env.tenantId, row.kind === "DEVELOPMENT" ? "DEVELOPMENT" : "JOB_DESCRIPTION", row.id, input.action !== "REJECT");
      let data;
      if (input.action === "APPROVE_DEVELOPMENT") {
        if (
          row.kind !== "DEVELOPMENT" ||
          row.status !== "PROPOSED" ||
          employee.managerCode !== env.who.employeeCode
        )
          fail(
            "MANAGER_REQUIRED",
            "The employee’s current manager must approve this development proposal",
            403,
          );
        if (!input.dueAt || Date.parse(input.dueAt) <= env.now.getTime())
          fail("DUE_DATE", "Choose a future reassessment due date");
        let practiceSelection;
        if (input.workOpportunityRef || input.supervisorCode) {
          const suggestion = row.payload.practiceMatching?.suggestions.find(
            (s) =>
              s.opportunityRef === input.workOpportunityRef &&
              s.supervisorCode === input.supervisorCode,
          );
          const opportunity =
            suggestion &&
            (await tx.assessmentIntegration.findFirst({
              where: {
                tenantId: env.tenantId,
                id: input.workOpportunityRef,
                kind: "WORK_OPPORTUNITY",
                status: "AVAILABLE",
                sequence: suggestion.sourceVersion,
              },
            }));
          if (!opportunity || !input.supervisorCode)
            fail(
              "PRACTICE_CHANGED",
              "Refresh and select a current matched practice opportunity",
              409,
            );
          const task = await tx.assessmentTaskVersion.findFirst({
            where: {
              tenantId: env.tenantId,
              taskCode: row.payload.taskCode,
              taskVersion: row.payload.taskVersion,
              status: "PUBLISHED",
            },
          });
          const qualification =
            task &&
            (await tx.assessmentQualification.findFirst({
              where: {
                tenantId: env.tenantId,
                employeeCode: input.supervisorCode,
                familyCode: task.familyCode,
                expiresAt: { gt: env.now },
              },
            }));
          if (
            !qualification?.calibration.passed ||
            qualification.flags.includes("DISQUALIFIED") ||
            !(
              qualification.scopes.includes("*") ||
              qualification.scopes.includes(task.definition.scope)
            )
          )
            fail(
              "RATER_UNQUALIFIED",
              "The proposed assessor no longer has a current calibrated scope",
            );
          const planning = await planningSnapshotFor(tx, env, {
            employeeCodes: [row.employeeCode, input.supervisorCode],
            from: new Date(
              Math.max(+env.now, Date.parse(opportunity.payload.from)),
            )
              .toISOString()
              .slice(0, 10),
            to: opportunity.payload.to.slice(0, 10),
          });
          practiceSelection = matchPracticeCandidate({
            action: row,
            opportunity,
            person: planning.employees[0],
            supervisor: planning.employees[1],
            now: env.now,
          });
          if (!practiceSelection)
            fail(
              "PRACTICE_CHANGED",
              "Capability or availability changed; refresh matching before approval",
              409,
            );
          if (
            qualification.expiresAt <=
            new Date(practiceSelection.earliestFinish)
          )
            fail(
              "RATER_UNQUALIFIED",
              "Assessor calibration must remain current through the proposed practice window",
            );
          if (
            Date.parse(input.dueAt) <
            Date.parse(practiceSelection.earliestFinish)
          )
            fail(
              "PRACTICE_DUE_DATE",
              "Reassessment must follow the proposed practice window",
            );
        }
        const plan = await tx.developmentPlan.create({
          data: {
            tenantId: env.tenantId,
            employeeId: employee.employeeRowId,
            title: `Task assessment development: ${row.employeeCode}`,
            description: `Approved from assessment ${row.sourceRef}`,
            reviewedById: env.who.employeeRowId,
            endDate: new Date(input.dueAt),
          },
        });
        const item = await tx.developmentPlanItem.create({
          data: {
            tenantId: env.tenantId,
            planId: plan.id,
            title: `${row.payload.taskCode} / ${row.payload.dimension}`,
            description: `Required level ${row.payload.target}. Closure requires approved practical reassessment.`,
            targetDate: new Date(input.dueAt),
          },
        });
        let enrollmentRef;
        if (input.courseRef) {
          if (
            !row.payload.suggestedLearning.some(
              (m) => m.courseRef === input.courseRef,
            )
          )
            fail("LEARNING_MAPPING", "Select an approved course mapping");
          const course = await tx.trainingCourse.findFirst({
            where: { tenantId: env.tenantId, id: Number(input.courseRef) },
          });
          if (!course)
            fail("LEARNING_MAPPING", "The mapped course is unavailable");
          const enrollment =
            (await tx.trainingEnrollment.findFirst({
              where: {
                tenantId: env.tenantId,
                courseId: course.id,
                employeeId: employee.employeeRowId,
                status: "ENROLLED",
              },
            })) ||
            (await tx.trainingEnrollment.create({
              data: {
                tenantId: env.tenantId,
                courseId: course.id,
                employeeId: employee.employeeRowId,
              },
            }));
          enrollmentRef = enrollment.id;
        }
        data = {
          status: "APPROVED",
          targetRef: String(item.id),
          payload: json({
            ...row.payload,
            approvedByCode: env.who.employeeCode,
            dueAt: input.dueAt,
            enrollmentRef,
            ...(practiceSelection
              ? {
                  practiceSelection,
                  workAllocationStatus: "AWAITING_PM_RECHECK",
                }
              : {}),
          }),
        };
      } else if (input.action === "REJECT") {
        if (row.status !== (row.kind === "JD" ? "OWNER_APPROVED" : "PROPOSED"))
          fail("INVALID_STATE", "Only a reviewed proposal can be rejected");
        data = { status: "REJECTED" };
      } else if (input.action === "OWNER_APPROVE_JD") {
        if (
          row.kind !== "JD" ||
          row.status !== "PROPOSED" ||
          row.payload.ownerCode !== env.who.employeeCode
        )
          fail(
            "OWNER_REQUIRED",
            "The role owner must approve the JD redline",
            403,
          );
        data = {
          status: "OWNER_APPROVED",
          payload: {
            ...row.payload,
            ownerApprovedByCode: env.who.employeeCode,
          },
        };
      } else {
        if (
          row.kind !== "JD" ||
          row.status !== "OWNER_APPROVED" ||
          row.payload.ownerApprovedByCode === env.who.employeeCode
        )
          fail(
            "HR_APPROVAL_REQUIRED",
            "Independent HR publication is required",
            403,
          );
        const position = await tx.position.findFirst({
          where: { tenantId: env.tenantId, id: Number(row.targetRef) },
        });
        if (
          !position ||
          hash({
            description: position.description,
            requirements: position.requirements,
            responsibilities: position.responsibilities,
            version: position.version,
          }) !== row.payload.currentDigest
        )
          fail(
            "JD_CHANGED",
            "Current job description changed. Regenerate the redline.",
            409,
          );
        const changed = await tx.position.updateMany({
          where: {
            tenantId: env.tenantId,
            id: position.id,
            version: position.version,
          },
          data: {
            requirements: row.payload.proposedRequirements,
            responsibilities: row.payload.proposedResponsibilities,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) fail("STALE_VERSION", "Position changed", 409);
        data = { status: "PUBLISHED" };
      }
      const result = await tx.assessmentIntegration.update({
        where: { id: row.id },
        data: { ...data, sequence: { increment: 1 } },
      });
      await audit(tx, env, input.action, row.id, input, result);
      return result;
    },
  );
}
export async function proposeJobDescription(
  tx,
  env,
  profile,
  employeeCode,
  reason,
) {
  const position = await tx.position.findFirst({
    where: { tenantId: env.tenantId, id: Number(profile.positionRef) },
  });
  if (!position)
    fail("POSITION_MAPPING", "Profile position is not mapped to this company");
  const tasks = await tx.assessmentTaskVersion.findMany({
    where: {
      tenantId: env.tenantId,
      OR: profile.definition.requirements.map((r) => ({
        taskCode: r.taskCode,
        taskVersion: r.taskVersion,
      })),
    },
  });
  const key = `${profile.id}:${position.version}`;
  const proposedRequirements = profile.definition.requirements
    .map(
      (r) =>
        `${r.taskCode}: K ${r.requiredK ?? "N/A"}, S ${r.requiredS ?? "N/A"}, V ${r.targetV ?? "N/A"}`,
    )
    .join("\n");
  const proposedResponsibilities = tasks
    .map((t) => `${t.definition.title}: ${t.definition.outcome}`)
    .join("\n");
  return tx.assessmentIntegration.upsert({
    where: { tenantId_kind_key: { tenantId: env.tenantId, kind: "JD", key } },
    create: {
      tenantId: env.tenantId,
      employeeCode,
      kind: "JD",
      key,
      sourceRef: profile.id,
      targetRef: String(position.id),
      status: "PROPOSED",
      payload: {
        ownerCode: profile.ownerCode,
        reason,
        current: {
          description: position.description,
          requirements: position.requirements,
          responsibilities: position.responsibilities,
        },
        currentDigest: hash({
          description: position.description,
          requirements: position.requirements,
          responsibilities: position.responsibilities,
          version: position.version,
        }),
        proposedRequirements,
        proposedResponsibilities,
        impact: profile.impactComparison || {},
      },
    },
    update: {},
  });
}
