import { provisioningTaskIds } from "./onboardingProvisioning.service.js";
import { randomUUID } from "node:crypto";
import { userIdToUuid } from "@trusoft/contracts/identity";
import {
  runOnboardingManagement,
  managementChecklist,
  onboardingFailure,
} from "./onboardingManagement.service.js";
import { createPortalTask } from "./onboardingPortalScreen.service.js";
import { ONBOARDING_STAGES } from "../lib/onboardingTaskInput.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
const name = (e) =>
  e?.employee_name ||
  [e?.first_name, e?.last_name].filter(Boolean).join(" ") ||
  null;
export async function getOnboardingDetail(id, tenantId) {
  return runOnboardingManagement(tenantId, "GET", async (tx, env) => {
    const c = await managementChecklist(tx, env, id, {
      include: {
        employee: {
          select: {
            id: true,
            employee_name: true,
            first_name: true,
            last_name: true,
            job_title: true,
            businessUnit: { select: { name: true, tenantId: true } },
          },
        },
        tasks: {
          where: { tenantId },
          orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        },
      },
    });
    const ids = [...new Set(c.tasks.map((t) => t.assigneeId).filter(Boolean))];
    const people = ids.length
      ? await tx.employee.findMany({
          where: { tenant_id: tenantId, id: { in: ids } },
          select: {
            id: true,
            employee_name: true,
            first_name: true,
            last_name: true,
          },
        })
      : [];
    const provisioning = await provisioningTaskIds(tx, tenantId, c.id);
    const names = new Map(people.map((p) => [p.id, name(p)]));
    const checklist = Object.fromEntries(ONBOARDING_STAGES.map((s) => [s, []]));
    for (const t of c.tasks) {
      const stage = ONBOARDING_STAGES.includes(t.stage)
        ? t.stage
        : "pre_joining";
      checklist[stage].push({
        id: t.id,
        title: t.title,
        description: t.description,
        assignee: names.get(t.assigneeId) || t.assigneeType,
        assigneeId: names.has(t.assigneeId) ? t.assigneeId : null,
        assigneeType: t.assigneeType,
        category: t.category || "OTHER",
        dueDate: t.dueDate,
        completed: t.completed,
        provisioning: provisioning.has(t.id),
        completedAt: t.completedAt,
        stage,
      });
    }
    const done = c.tasks.filter((t) => t.completed).length;
    return {
      id: c.id,
      employeeId: c.employeeId,
      newHireName: name(c.employee),
      role: c.employee.job_title,
      department:
        c.employee.businessUnit?.tenantId === tenantId
          ? c.employee.businessUnit.name
          : null,
      joiningDate: c.startDate,
      progress: c.tasks.length ? Math.round((done / c.tasks.length) * 100) : 0,
      tasksDone: done,
      tasksTotal: c.tasks.length,
      status: c.status,
      currentStage: c.currentStage,
      checklist,
    };
  });
}
export async function createOnboardingTask(input, tenantId) {
  return createPortalTask({
    tenantId,
    checklistId: input.checklistId,
    title: input.title,
    stage: input.stage,
    deadline: input.startDate,
    responsibleId: input.assigneeId,
    assigneeType: input.assigneeType,
    description: input.notes,
    category: input.category,
  });
}
// The recipient is always the checklist's active new hire. No caller-supplied
// mailbox, message content, or identity crosses the notification boundary.
export async function sendOnboardingReminder(input, tenantId) {
  return runOnboardingManagement(tenantId, "POST", async (tx, env) => {
    const c = await managementChecklist(tx, env, input.checklistId, {
      lock: true,
    });
    if (input.sendTo || input.subject || input.message)
      onboardingFailure(
        "The reminder uses the employee portal and a standard in-app message",
        422,
      );
    const key = input.idempotencyKey;
    if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(key))
      onboardingFailure("A stable reminder request key is required", 422);
    const log = Array.isArray(c.activityLog) ? c.activityLog : [];
    const old = log.find(
      (e) => e.kind === "REMINDER_QUEUED" && e.requestKey === key,
    );
    if (old)
      return {
        queued: true,
        checklistId: c.id,
        channel: "in_app",
        queuedAt: old.at,
      };
    const p = await tx.employee.findFirst({
      where: { tenant_id: tenantId, id: c.employeeId },
      select: { userId: true, status: true, employement_status: true },
    });
    if (
      !p?.userId ||
      p.userId <= 0 ||
      /inactive|terminated|exited|offboard|separated/i.test(
        [p.status, p.employement_status].join(" "),
      )
    )
      onboardingFailure(
        "The new hire needs an active linked ERP account before receiving a reminder",
        409,
      );
    const at = new Date().toISOString();
    const event = await enqueueHrDomainEvent(tx, {
      tenantId,
      actorId: String(env.who.id),
      actorType: "user",
      eventName: "hr.onboarding.reminder_requested.v1",
      aggregateType: "OnboardingChecklist",
      aggregateId: String(c.id),
      payload: {
        checklistId: String(c.id),
        employeeId: String(c.employeeId),
        actorId: String(env.who.id),
        recipientUserId: userIdToUuid(tenantId, p.userId),
      },
    });
    if (!event) onboardingFailure("Reminder could not be queued", 503);
    await tx.onboardingChecklist.update({
      where: { id: c.id },
      data: {
        activityLog: [
          ...log,
          {
            id: randomUUID(),
            kind: "REMINDER_QUEUED",
            at,
            actor: String(env.who.id),
            text: "Onboarding reminder queued in the employee inbox",
            requestKey: key,
          },
        ],
      },
    });
    return { queued: true, checklistId: c.id, channel: "in_app", queuedAt: at };
  });
}
