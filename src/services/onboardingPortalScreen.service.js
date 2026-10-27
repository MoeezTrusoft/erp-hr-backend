import {
  calendarViews,
  sessionCalendarView,
} from "./onboardingCalendar.service.js";
import {
  ensureProvisioningRequests,
  guardProvisioningTaskMutation,
  provisioningTaskIds,
} from "./onboardingProvisioning.service.js";
import { validateOnboardingTask } from "../lib/onboardingTaskInput.js";
import { isDeepStrictEqual } from "node:util";
// src/services/onboardingPortalScreen.service.js
//
// Backend for the FE "Onboarding Portal" — the NEW-EMPLOYEE self-service screen.
// Distinct from onboardingPortal.service.js (the HR pre-boarding readiness board)
// and onboardingDashboard.service.js (the HR management list). This screen shows
// the new hire their own portal: profile header (self + manager + buddy +
// location + joining date), onboarding tasks grouped by CATEGORY with a
// responsible employee, a radio-questionnaire feedback form, and a per-task
// "send reminder" that auto-addresses the task's responsible person.
//
// Every read/write threads the VERIFIED tenant (fail-closed) and mutations that
// touch >1 statement run inside tenantTransaction so the RLS GUC is set.
import { isRecruitmentFlagEnabled } from "../lib/recruitmentFlags.js";
import {
  ONBOARDING_MILESTONES,
  milestoneDueAt,
  milestoneView,
  validateMilestoneResponse,
} from "../lib/onboardingMilestones.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../utils/AppError.js";
import logger from "../lib/logger.js";
import { hasPermission } from "../lib/assertPermission.js";
import { onboardingPortalAccess } from "../lib/onboardingPortalAccess.js";
import { actor as linkedEmployee } from "./separation/base.js";
import {
  scopedWhere,
  scopedData,
  scopedEmployeeWhere,
} from "../lib/tenancy.js";
import { tenantTransaction } from "../lib/rlsTenant.js";
import { enqueueHrDomainEvent } from "./hrDomainEvent.service.js";
import { onboardingTaskReminderEvent } from "./hrEvents.js";
import {
  ONBOARDING_TASK_CATEGORIES,
  ONBOARDING_FEEDBACK_QUESTIONS,
  onboardingCategoryLabel,
  validateFeedbackAnswers,
} from "../lib/onboardingTaxonomy.js";

// Email is intentionally disabled at the source until the notification-hub
// mapper is flipped on (same posture as document-expiry reminders).
const EMAIL_ENABLED =
  String(process.env.ONBOARDING_EMAIL_ENABLED || "").toLowerCase() === "true";

// ── selects ──────────────────────────────────────────────────────────────────
// Employee profile shape used everywhere on this screen (snake_case columns).
const employeeProfileSelect = {
  id: true,
  employee_name: true,
  first_name: true,
  last_name: true,
  job_title: true,
  photo_url: true,
};

const employeeName = (e) => {
  if (!e) return null;
  const denorm = e.employee_name && String(e.employee_name).trim();
  if (denorm) return denorm;
  const joined = `${e.first_name || ""} ${e.last_name || ""}`.trim();
  return joined || null;
};

// { id, name, role, avatarUrl } — null when the employee is absent.
const profileOf = (e) =>
  e
    ? {
        id: e.id,
        name: employeeName(e),
        role: e.job_title || null,
        avatarUrl: e.photo_url || null,
      }
    : null;

const taskRow = (t) => ({
  id: t.id,
  title: t.title,
  description: t.description || null,
  category: t.category || "OTHER",
  categoryLabel: onboardingCategoryLabel(t.category),
  deadline: t.dueDate || null,
  status: t.completed ? "DONE" : "PENDING",
  done: !!t.completed,
  completedAt: t.completedAt || null,
  responsible: profileOf(t.assignee),
  stage: t.stage || null,
});

// ── checklist resolution ─────────────────────────────────────────────────────
// Resolve the target checklist for the portal: an explicit checklistId wins,
// else the caller's (or given employee's) most-relevant checklist — prefer a
// still-open one, else the most recent.
async function portalRun(tenantId, method, selfAllowed, fn) {
  const access = onboardingPortalAccess(method, { selfAllowed, tenantId });
  return tenantTransaction(
    prisma,
    async (tx) => {
      const who = await linkedEmployee(tx, access.ctx);
      return fn(tx, { ...access, who });
    },
    { tenantId: access.tenantId },
  );
}
async function portalEvent(tx, env, checklist, event, payload) {
  const queued = await enqueueHrDomainEvent(tx, {
    tenantId: env.tenantId,
    actorId: String(env.who.id),
    actorType: "user",
    eventName: "hr.onboarding." + event + ".v1",
    aggregateType: "OnboardingChecklist",
    aggregateId: String(checklist.id),
    payload: {
      checklistId: String(checklist.id),
      employeeId: String(checklist.employeeId),
      actorId: String(env.who.id),
      ...payload,
    },
  });
  if (!queued) throw new AppError("Onboarding event could not be saved", 503);
}
const missing = () => new AppError("Onboarding checklist not found", 404);
async function resolveChecklist(
  { checklistId, employeeId },
  tx,
  env,
  { ownOnly = false, lock = false } = {},
) {
  const target = employeeId == null ? env.who.id : Number(employeeId);
  if (!Number.isSafeInteger(target) || target <= 0) throw missing();
  if ((!env.hr || ownOnly) && target !== env.who.id) throw missing();
  const where = {
    tenantId: env.tenantId,
    ...(!env.hr || ownOnly || checklistId == null
      ? { employeeId: target }
      : {}),
    ...(checklistId == null ? {} : { id: Number(checklistId) }),
  };
  let c =
    checklistId == null
      ? await tx.onboardingChecklist.findFirst({
          where: { ...where, status: { not: "COMPLETED" } },
          orderBy: [{ startDate: "desc" }, { id: "desc" }],
        })
      : null;
  c ||= await tx.onboardingChecklist.findFirst({
    where,
    orderBy: [{ startDate: "desc" }, { id: "desc" }],
  });
  if (!c || (employeeId != null && c.employeeId !== target)) throw missing();
  if (lock) {
    await tx.$queryRaw`SELECT id FROM onboarding_checklists WHERE id=${c.id} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
    c = await tx.onboardingChecklist.findFirst({
      where: { ...where, id: c.id },
    });
    if (!c) throw missing();
  }
  return c;
}
const onboardingCanEdit = (env) =>
  hasPermission(env.ctx.permissions, "hr:onboarding", "EDIT");
const ownsTask = (t, employeeId) =>
  t.assigneeId === employeeId ||
  (t.assigneeId == null && t.assigneeType === "NEW_HIRE");
const taskFor = (t, env) => ({
  ...taskRow(t),
  assigneeType: t.assigneeType,
  canComplete: env.hr || ownsTask(t, env.who.id),
});
async function responsible(tx, env, value) {
  if (value == null) return null;
  const id = Number(value);
  const employee =
    Number.isSafeInteger(id) &&
    id > 0 &&
    (await tx.employee.findFirst({
      where: { tenant_id: env.tenantId, id },
      select: { id: true },
    }));
  if (!employee) throw new AppError("Responsible employee not found", 404);
  return id;
}
async function taskScoped(tx, env, taskId) {
  const task = await tx.onboardingTask.findFirst({
    where: { tenantId: env.tenantId, id: Number(taskId) },
  });
  if (!task) throw new AppError("Onboarding task not found", 404);
  const checklist = await resolveChecklist(
    { checklistId: task.checklistId },
    tx,
    env,
    { lock: true },
  );
  await tx.$queryRaw`SELECT id FROM onboarding_tasks WHERE id=${task.id} AND "tenantId"=${env.tenantId}::uuid FOR UPDATE`;
  const fresh = await tx.onboardingTask.findFirst({
    where: { tenantId: env.tenantId, id: task.id, checklistId: checklist.id },
  });
  if (!fresh) throw new AppError("Onboarding task not found", 404);
  return { task: fresh, checklist };
}

// ── portal header + tasks ────────────────────────────────────────────────────
export async function getOnboardingPortal({
  tenantId,
  employeeId,
  checklistId,
} = {}) {
  return portalRun(tenantId, "GET", true, async (tx, env) => {
    const checklist = await resolveChecklist(
      { checklistId, employeeId },
      tx,
      env,
    );

    // Employee (the new hire) + manager, tenant-scoped on Employee's snake_case col.
    const employee = await tx.employee.findFirst({
      where: scopedEmployeeWhere(tenantId, { id: checklist.employeeId }),
      select: {
        ...employeeProfileSelect,
        joining_date: true,
        hire_date: true,
        city: true,
        state: true,
        country: true,
        work_mode: true,
        region: { select: { name: true } },
        manager: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
      },
    });
    if (!employee) throw new AppError("Employee not found", 404);

    // Buddy (one per checklist).
    const buddyRow = await tx.onboardingBuddy.findFirst({
      where: scopedWhere(tenantId, {
        checklistId: checklist.id,
        buddy: { is: { tenant_id: tenantId } },
      }),
      include: {
        buddy: { select: employeeProfileSelect },
      },
    });

    // Tasks with the responsible employee joined in.
    const tasks = await tx.onboardingTask.findMany({
      where: scopedWhere(tenantId, { checklistId: checklist.id }),
      include: {
        assignee: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
      },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });

    const location =
      employee.region?.name ||
      [employee.city, employee.country].filter(Boolean).join(", ") ||
      null;

    const provisioned = await provisioningTaskIds(tx, tenantId, checklist.id);
    const rows = tasks.map((t) => ({
      ...taskFor(t, { ...env, hr: env.hr && onboardingCanEdit(env) }),
      ...(provisioned.has(t.id)
        ? { canComplete: false, provisioning: true }
        : {}),
    }));
    const doneCount = rows.filter((r) => r.done).length;

    // Group task rows by category for the FE (also return the flat list).
    const byCategory = {};
    for (const cat of ONBOARDING_TASK_CATEGORIES) byCategory[cat] = [];
    for (const r of rows) (byCategory[r.category] || byCategory.OTHER).push(r);

    const feedback = await tx.onboardingFeedback.findFirst({
      where: scopedWhere(tenantId, {
        checklistId: checklist.id,
        employeeId: checklist.employeeId,
      }),
      select: { id: true, submittedAt: true },
    });

    const sessions = await tx.onboardingSession.findMany({
      where: { tenantId, checklistId: checklist.id },
      orderBy: [{ sessionDate: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        title: true,
        sessionDate: true,
        fromTime: true,
        toTime: true,
        sessionType: true,
        location: true,
      },
    });
    const sessionCalendars = await calendarViews(
      tx,
      tenantId,
      sessions.map((s) => s.id),
    );
    return {
      checklistId: checklist.id,
      status: checklist.status,
      startDate: checklist.startDate,
      targetDate: checklist.targetDate || null,
      employee: {
        ...profileOf(employee),
        joiningDate:
          employee.joining_date ||
          employee.hire_date ||
          checklist.startDate ||
          null,
        location,
        workMode: employee.work_mode || null,
      },
      manager: profileOf(employee.manager),
      buddy: buddyRow ? profileOf(buddyRow.buddy) : null,
      tasks: rows,
      tasksByCategory: byCategory,
      progress: {
        total: rows.length,
        done: doneCount,
        pending: rows.length - doneCount,
        percent: rows.length ? Math.round((doneCount / rows.length) * 100) : 0,
      },
      canSubmitFeedback: checklist.employeeId === env.who.id,
      sessions: sessions.map((s) => ({
        ...s,
        calendar: sessionCalendars.get(s.id) || sessionCalendarView(null),
      })),
      milestones: milestoneView(
        checklist,
        await tx.onboardingSurvey.findMany({
          where: {
            tenantId,
            checklistId: checklist.id,
            employeeId: checklist.employeeId,
          },
        }),
        {
          enabled: isRecruitmentFlagEnabled("onboarding"),
          canSubmit: checklist.employeeId === env.who.id,
        },
      ),
      feedbackSubmitted: !!feedback,
      feedbackSubmittedAt: feedback?.submittedAt || null,
    };
  });
}

// Management operations remain HR-only; the employee gets only the narrow
// completion action. Lock the parent before the task to serialize feedback
// and completion with other portal mutations.
export async function createPortalTask({
  tenantId,
  checklistId,
  employeeId,
  title,
  category,
  deadline,
  responsibleId,
  description,
  stage,
  assigneeType,
} = {}) {
  validateOnboardingTask(
    { title, description, category, stage, assigneeType, deadline },
    { create: true },
  );
  return portalRun(tenantId, "POST", false, async (tx, env) => {
    const checklist = await resolveChecklist(
      { checklistId, employeeId },
      tx,
      env,
      { lock: true },
    );
    const created = await tx.onboardingTask.create({
      data: scopedData(tenantId, {
        checklistId: checklist.id,
        title: title.trim(),
        assigneeType: assigneeType ?? "HR",
        description: description ?? null,
        category: category ?? "OTHER",
        stage: stage ?? null,
        assigneeId: await responsible(tx, env, responsibleId),
        dueDate: deadline ? new Date(deadline) : null,
        completed: false,
      }),
      include: {
        assignee: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
      },
    });
    await portalEvent(tx, env, checklist, "task_changed", {
      taskId: String(created.id),
      action: "CREATED",
    });
    await ensureProvisioningRequests(tx, tenantId, checklist.id);
    return taskFor(created, env);
  });
}
export async function updatePortalTask({ tenantId, taskId, ...patch } = {}) {
  validateOnboardingTask(patch);
  return portalRun(tenantId, "PUT", false, async (tx, env) => {
    const { task, checklist } = await taskScoped(tx, env, taskId),
      data = {};
    for (const key of [
      "title",
      "description",
      "category",
      "stage",
      "assigneeType",
    ])
      if (patch[key] !== undefined) data[key] = patch[key];
    if (patch.deadline !== undefined)
      data.dueDate = patch.deadline ? new Date(patch.deadline) : null;
    if (patch.responsibleId !== undefined)
      data.assigneeId = await responsible(tx, env, patch.responsibleId);
    if (patch.done !== undefined) {
      data.completed = !!patch.done;
      data.completedAt = patch.done ? task.completedAt || new Date() : null;
    }
    await guardProvisioningTaskMutation(tx, tenantId, task, patch);
    const updated = await tx.onboardingTask.update({
      where: { id: task.id },
      data,
      include: {
        assignee: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
      },
    });
    await portalEvent(tx, env, checklist, "task_changed", {
      taskId: String(task.id),
      action: "UPDATED",
    });
    await ensureProvisioningRequests(tx, tenantId, checklist.id);
    return taskFor(updated, env);
  });
}
export async function completePortalTask({
  tenantId,
  taskId,
  done = true,
} = {}) {
  if (typeof done !== "boolean")
    throw new AppError("Completion must be true or false", 400);
  return portalRun(tenantId, "PUT", true, async (tx, env) => {
    const { task, checklist } = await taskScoped(tx, env, taskId);
    if (!env.hr && !ownsTask(task, env.who.id))
      throw new AppError(
        "Only the responsible employee can complete this task",
        403,
      );
    await guardProvisioningTaskMutation(tx, tenantId, task, { done });
    const updated = await tx.onboardingTask.update({
      where: { id: task.id },
      data: {
        completed: done,
        completedAt: done ? task.completedAt || new Date() : null,
      },
      include: {
        assignee: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
      },
    });
    if (task.completed !== done)
      await portalEvent(tx, env, checklist, "task_changed", {
        taskId: String(task.id),
        action: done ? "COMPLETED" : "REOPENED",
      });
    return taskFor(updated, env);
  });
}
export async function deletePortalTask({ tenantId, taskId } = {}) {
  return portalRun(tenantId, "DELETE", false, async (tx, env) => {
    const { task, checklist } = await taskScoped(tx, env, taskId);
    await guardProvisioningTaskMutation(tx, tenantId, task, {}, true);
    const linked = await tx.$queryRawUnsafe(
      'SELECT "sessionId" FROM "OnboardingSessionCalendar" WHERE "tenantId"=$1::uuid AND "taskId"=$2',
      tenantId,
      task.id,
    );
    if (linked.length)
      throw new AppError(
        "This task has a linked onboarding session and must be retained with its calendar history",
        409,
      );
    await tx.onboardingTask.delete({ where: { id: task.id } });
    await portalEvent(tx, env, checklist, "task_changed", {
      taskId: String(task.id),
      action: "DELETED",
    });
    return { deleted: true, id: task.id };
  });
}
export async function getFeedbackQuestions({
  tenantId,
  checklistId,
  employeeId,
} = {}) {
  return portalRun(tenantId, "GET", true, async (tx, env) => {
    const checklist = await resolveChecklist(
      { checklistId, employeeId },
      tx,
      env,
    );
    const existing = await tx.onboardingFeedback.findFirst({
      where: {
        tenantId,
        checklistId: checklist.id,
        employeeId: checklist.employeeId,
      },
      select: { responses: true, comments: true, submittedAt: true },
    });
    return {
      questions: ONBOARDING_FEEDBACK_QUESTIONS,
      canSubmit: checklist.employeeId === env.who.id,
      submitted: !!existing,
      responses: existing?.responses ?? null,
      comments: existing?.comments ?? null,
      submittedAt: existing?.submittedAt ?? null,
    };
  });
}
export async function submitPortalFeedback({
  tenantId,
  checklistId,
  employeeId,
  answers,
  comments,
} = {}) {
  const check = validateFeedbackAnswers(answers);
  if (!check.ok) throw new AppError("Invalid feedback: " + check.error, 400);
  if (check.normalized.length !== ONBOARDING_FEEDBACK_QUESTIONS.length)
    throw new AppError("Answer every feedback question", 400);
  if (
    comments != null &&
    (typeof comments !== "string" || comments.length > 4000)
  )
    throw new AppError("Comments must be at most 4000 characters", 400);
  return portalRun(tenantId, "POST", true, async (tx, env) => {
    const checklist = await resolveChecklist(
      { checklistId, employeeId },
      tx,
      env,
      { ownOnly: true, lock: true },
    );
    const old = await tx.onboardingFeedback.findFirst({
      where: { tenantId, checklistId: checklist.id },
    });
    if (old && old.employeeId !== env.who.id)
      throw new AppError("Feedback ownership requires HR correction", 409);
    const payload = {
      employeeId: env.who.id,
      responses: check.normalized,
      comments: comments?.trim() || null,
      submittedAt: new Date(),
    };
    const saved = await tx.onboardingFeedback.upsert({
      where: { checklistId: checklist.id },
      create: scopedData(tenantId, { ...payload, checklistId: checklist.id }),
      update: payload,
    });
    await portalEvent(tx, env, checklist, "feedback_submitted", {
      feedbackId: String(saved.id),
    });
    return {
      id: saved.id,
      checklistId: saved.checklistId,
      submittedAt: saved.submittedAt,
      answers: saved.responses,
      comments: saved.comments,
    };
  });
}

// ── send reminder (auto-selects the task's responsible person) ───────────────
export async function sendTaskReminder({
  tenantId,
  taskId,
  subject,
  message,
  actor,
} = {}) {
  return portalRun(tenantId, "POST", false, async (tx, env) => {
    await taskScoped(tx, env, taskId);
    actor = env.who;
    const task = await tx.onboardingTask.findFirst({
      where: scopedWhere(tenantId, { id: Number(taskId) }),
      include: {
        assignee: {
          where: { tenant_id: tenantId },
          select: employeeProfileSelect,
        },
        checklist: { select: { id: true, employeeId: true } },
      },
    });
    if (!task) throw new AppError("Onboarding task not found", 404);

    // AUTO-select the recipient: the task's responsible employee.
    const recipient = task.assignee ? profileOf(task.assignee) : null;
    if (!recipient) {
      throw new AppError(
        "This task has no responsible person assigned to remind",
        400,
      );
    }

    const categoryLabel = onboardingCategoryLabel(task.category);
    const finalSubject = subject || `Reminder: ${task.title}`;
    const finalMessage =
      message ||
      `This is a reminder to complete the onboarding task "${task.title}" (${categoryLabel})` +
        (task.dueDate
          ? ` due ${new Date(task.dueDate).toISOString().slice(0, 10)}`
          : "") +
        ".";

    // Emit the outbox event (in-app now, email disabled at source).
    const event = onboardingTaskReminderEvent(
      task,
      { actorId: actor.id },
      {
        employeeId: task.checklist?.employeeId,
        recipientId: recipient.id,
        subject: finalSubject,
        message: finalMessage,
        emailEnabled: EMAIL_ENABLED,
      },
    );
    if (event && event.tenantId) {
      await enqueueHrDomainEvent(tx, event);
    } else {
      logger.warn(
        { taskId },
        "onboarding reminder: no tenant on task row; event skipped",
      );
    }

    return {
      sent: true,
      taskId: task.id,
      recipient,
      subject: finalSubject,
      message: finalMessage,
      channels: { inApp: true, email: EMAIL_ENABLED },
      sentAt: new Date().toISOString(),
    };
  });
}

export async function submitPortalMilestone({
  tenantId,
  checklistId,
  employeeId,
  type,
  answers,
  comments,
} = {}) {
  if (!isRecruitmentFlagEnabled("onboarding"))
    throw new AppError("Onboarding surveys are not enabled", 409);
  const milestone = ONBOARDING_MILESTONES.find((m) => m.type === type);
  if (!milestone) throw new AppError("Unknown onboarding milestone", 422);
  const responses = validateMilestoneResponse(answers, comments);
  return portalRun(tenantId, "POST", true, async (tx, env) => {
    const checklist = await resolveChecklist(
      { checklistId, employeeId },
      tx,
      env,
      { ownOnly: true, lock: true },
    );
    if (+milestoneDueAt(checklist.startDate, milestone.days) > Date.now())
      throw new AppError("This survey is not due yet", 409);
    const existing = await tx.onboardingSurvey.findFirst({
      where: { tenantId, checklistId: checklist.id, type },
    });
    if (existing?.employeeId && existing.employeeId !== env.who.id)
      throw new AppError("Survey ownership requires HR correction", 409);
    if (
      existing?.submittedAt &&
      isDeepStrictEqual(existing.responses, responses)
    )
      return existing;
    const saved = await tx.onboardingSurvey.upsert({
      where: { checklistId_type: { checklistId: checklist.id, type } },
      create: {
        tenantId,
        checklistId: checklist.id,
        employeeId: env.who.id,
        type,
        responses,
        submittedAt: new Date(),
      },
      update: { responses, submittedAt: new Date() },
    });
    await portalEvent(tx, env, checklist, "survey_submitted", {
      surveyId: String(saved.id),
      type,
    });
    return saved;
  });
}
