import prisma from "../lib/prisma.js";
import {
  currentRequestContext,
  runWithRequestContext,
} from "../lib/requestContext.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  ONBOARDING_MILESTONES,
  milestoneDueAt,
} from "../lib/onboardingMilestones.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { userIdToUuid } from "@trusoft/contracts/identity";
const active = (employee) =>
  employee &&
  !/inactive|terminated|exited|offboard|separated/i.test(
    [employee.status, employee.employement_status].join(" "),
  );
export async function runOnboardingAutomation({
  now = new Date(),
  tenantId,
} = {}) {
  if (!currentRequestContext()?.system)
    throw Object.assign(new Error("Scheduler identity required"), {
      status: 403,
    });
  if (!isRecruitmentFlagEnabled("onboarding"))
    return { skipped: true, reason: "flag-disabled" };
  if (!Number.isFinite(+now)) throw new Error("Valid scheduler time required");
  const result = { scanned: 0, surveysCreated: 0, enqueued: 0, unroutable: 0 };
  const tenants = await prisma.onboardingChecklist.findMany({
    where: {
      tenantId: tenantId ?? { not: null },
      startDate: { lte: milestoneDueAt(now, 2) },
    },
    distinct: ["tenantId"],
    select: { tenantId: true },
  });
  for (const { tenantId: company } of tenants)
    await runWithRequestContext(
      { system: false, user: { tenantId: company } },
      async () => {
        let cursor = 0;
        for (;;) {
          const page = await prisma.onboardingChecklist.findMany({
            where: {
              tenantId: company,
              id: { gt: cursor },
              startDate: { lte: milestoneDueAt(now, 2) },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: 200,
          });
          for (const ref of page)
            await tenantTransaction(
              prisma,
              async (tx) => {
                await tx.$queryRawUnsafe(
                  'SELECT id FROM onboarding_checklists WHERE "tenantId"=$1::uuid AND id=$2 FOR UPDATE',
                  company,
                  ref.id,
                );
                const checklist = await tx.onboardingChecklist.findFirst({
                  where: { tenantId: company, id: ref.id },
                  include: {
                    employee: true,
                    tasks: { where: { tenantId: company } },
                    surveys: { where: { tenantId: company } },
                  },
                });
                result.scanned++;
                if (
                  !checklist ||
                  checklist.employee.tenant_id !== company ||
                  !active(checklist.employee)
                )
                  return;
                const actions = [];
                for (const milestone of ONBOARDING_MILESTONES) {
                  const dueAt = milestoneDueAt(
                    checklist.startDate,
                    milestone.days,
                  );
                  if (+dueAt > +now) continue;
                  let survey = checklist.surveys.find(
                    (s) => s.type === milestone.type,
                  );
                  if (survey && survey.employeeId !== checklist.employeeId) {
                    result.unroutable++;
                    continue;
                  }
                  if (!survey) {
                    survey = await tx.onboardingSurvey.create({
                      data: {
                        tenantId: company,
                        checklistId: checklist.id,
                        employeeId: checklist.employeeId,
                        type: milestone.type,
                      },
                    });
                    result.surveysCreated++;
                  }
                  if (!survey.submittedAt)
                    actions.push({
                      kind: milestone.type,
                      dueAt,
                      ids: [checklist.employeeId],
                    });
                }
                const readinessDue = milestoneDueAt(checklist.startDate, -2);
                if (
                  checklist.status !== "COMPLETED" &&
                  +readinessDue <= +now &&
                  +now < +checklist.startDate
                ) {
                  const incomplete = checklist.tasks.some(
                    (t) =>
                      !t.completed &&
                      (["pre_joining", "pre_boarding"].includes(t.stage) ||
                        (["IT_ACCESS_SETUP", "WORKSPACE_EQUIPMENT"].includes(
                          t.category,
                        ) &&
                          (!t.dueDate || +t.dueDate <= +checklist.startDate))),
                  );
                  if (incomplete) {
                    const handoff = await tx.offerHandoff.findFirst({
                        where: { tenantId: company, checklistId: checklist.id },
                        select: {
                          offer: {
                            select: {
                              jobRequisition: {
                                select: {
                                  tenantId: true,
                                  recruiterId: true,
                                  requestedById: true,
                                },
                              },
                            },
                          },
                        },
                      }),
                      req = handoff?.offer.jobRequisition;
                    if (!req?.recruiterId) result.unroutable++;
                    const ids = [
                      checklist.employee.managerId,
                      ...(req?.tenantId === company
                        ? [req.recruiterId, req.requestedById]
                        : []),
                    ];
                    actions.push({
                      kind: "READINESS",
                      dueAt: readinessDue,
                      ids,
                    });
                  }
                }
                for (const action of actions) {
                  const ids = [
                    ...new Set(action.ids.filter(Number.isSafeInteger)),
                  ];
                  const people = ids.length
                    ? await tx.employee.findMany({
                        where: {
                          tenant_id: company,
                          id: { in: ids },
                          userId: { gt: 0 },
                        },
                        select: {
                          userId: true,
                          status: true,
                          employement_status: true,
                        },
                      })
                    : [];
                  const routed = [
                    ...new Map(
                      people.filter(active).map((p) => [p.userId, p]),
                    ).values(),
                  ];
                  result.unroutable += ids.length
                    ? ids.length - routed.length
                    : 1;
                  for (const person of routed) {
                    const inserted = await tx.$queryRawUnsafe(
                      'INSERT INTO "OnboardingNotice" ("tenantId","checklistId","recipientUserId","checklistStartAt",kind,"dueAt","createdAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id',
                      company,
                      checklist.id,
                      person.userId,
                      checklist.startDate,
                      action.kind,
                      action.dueAt,
                      now,
                    );
                    if (!inserted.length) continue;
                    const event = await enqueueHrDomainEvent(tx, {
                      tenantId: company,
                      eventName: "hr.onboarding.action_due.v1",
                      aggregateType: "OnboardingChecklist",
                      aggregateId: String(checklist.id),
                      occurredAt: now.toISOString(),
                      payload: {
                        checklistId: String(checklist.id),
                        employeeId: String(checklist.employeeId),
                        kind: action.kind,
                        dueAt: action.dueAt.toISOString(),
                        recipientUserIds: [
                          userIdToUuid(company, person.userId),
                        ],
                      },
                    });
                    if (!event)
                      throw Error(
                        "Onboarding notification event was not saved",
                      );
                    result.enqueued++;
                  }
                }
              },
              {
                tenantId: company,
                txOptions: { maxWait: 10000, timeout: 30000 },
              },
            );
          if (page.length < 200) break;
          cursor = page.at(-1).id;
        }
      },
    );
  return result;
}
