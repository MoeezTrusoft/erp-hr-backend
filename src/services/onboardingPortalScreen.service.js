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
import prisma from "../lib/prisma.js";
import { AppError } from "../utils/AppError.js";
import logger from "../lib/logger.js";
import { scopedWhere, scopedData, scopedEmployeeWhere } from "../lib/tenancy.js";
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
const EMAIL_ENABLED = String(process.env.ONBOARDING_EMAIL_ENABLED || "").toLowerCase() === "true";

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
  e ? { id: e.id, name: employeeName(e), role: e.job_title || null, avatarUrl: e.photo_url || null } : null;

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
async function resolveChecklist({ tenantId, checklistId, employeeId }) {
  if (checklistId != null) {
    const c = await prisma.onboardingChecklist.findFirst({
      where: scopedWhere(tenantId, { id: Number(checklistId) }),
    });
    if (!c) throw new AppError("Onboarding checklist not found", 404);
    return c;
  }
  if (employeeId == null) {
    throw new AppError("employeeId or checklistId is required (no employee bound to the session)", 400);
  }
  const open = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { employeeId: Number(employeeId), status: { not: "COMPLETED" } }),
    orderBy: { startDate: "desc" },
  });
  if (open) return open;
  const any = await prisma.onboardingChecklist.findFirst({
    where: scopedWhere(tenantId, { employeeId: Number(employeeId) }),
    orderBy: { startDate: "desc" },
  });
  if (!any) throw new AppError("No onboarding checklist for this employee", 404);
  return any;
}

// ── portal header + tasks ────────────────────────────────────────────────────
export async function getOnboardingPortal({ tenantId, employeeId, checklistId } = {}) {
  const checklist = await resolveChecklist({ tenantId, checklistId, employeeId });

  // Employee (the new hire) + manager, tenant-scoped on Employee's snake_case col.
  const employee = await prisma.employee.findFirst({
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
      manager: { select: employeeProfileSelect },
    },
  });
  if (!employee) throw new AppError("Employee not found", 404);

  // Buddy (one per checklist).
  const buddyRow = await prisma.onboardingBuddy.findFirst({
    where: scopedWhere(tenantId, { checklistId: checklist.id }),
    include: { buddy: { select: employeeProfileSelect } },
  });

  // Tasks with the responsible employee joined in.
  const tasks = await prisma.onboardingTask.findMany({
    where: scopedWhere(tenantId, { checklistId: checklist.id }),
    include: { assignee: { select: employeeProfileSelect } },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });

  const location =
    employee.region?.name ||
    [employee.city, employee.country].filter(Boolean).join(", ") ||
    null;

  const rows = tasks.map(taskRow);
  const doneCount = rows.filter((r) => r.done).length;

  // Group task rows by category for the FE (also return the flat list).
  const byCategory = {};
  for (const cat of ONBOARDING_TASK_CATEGORIES) byCategory[cat] = [];
  for (const r of rows) (byCategory[r.category] || byCategory.OTHER).push(r);

  const feedback = await prisma.onboardingFeedback.findFirst({
    where: scopedWhere(tenantId, { checklistId: checklist.id }),
    select: { id: true, submittedAt: true },
  });

  return {
    checklistId: checklist.id,
    status: checklist.status,
    startDate: checklist.startDate,
    targetDate: checklist.targetDate || null,
    employee: {
      ...profileOf(employee),
      joiningDate: employee.joining_date || employee.hire_date || checklist.startDate || null,
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
    feedbackSubmitted: !!feedback,
    feedbackSubmittedAt: feedback?.submittedAt || null,
  };
}

// ── task CRUD ────────────────────────────────────────────────────────────────
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
} = {}) {
  const checklist = await resolveChecklist({ tenantId, checklistId, employeeId });
  const created = await prisma.onboardingTask.create({
    data: scopedData(tenantId, {
      checklistId: checklist.id,
      title,
      description: description ?? null,
      category: category ?? "OTHER",
      stage: stage ?? null,
      assigneeId: responsibleId != null ? Number(responsibleId) : null,
      dueDate: deadline ? new Date(deadline) : null,
      completed: false,
    }),
    include: { assignee: { select: employeeProfileSelect } },
  });
  return taskRow(created);
}

async function loadTaskScoped(tenantId, taskId) {
  const task = await prisma.onboardingTask.findFirst({
    where: scopedWhere(tenantId, { id: Number(taskId) }),
  });
  if (!task) throw new AppError("Onboarding task not found", 404);
  return task;
}

export async function updatePortalTask({ tenantId, taskId, ...patch } = {}) {
  await loadTaskScoped(tenantId, taskId);
  const data = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.category !== undefined) data.category = patch.category;
  if (patch.stage !== undefined) data.stage = patch.stage;
  if (patch.deadline !== undefined) data.dueDate = patch.deadline ? new Date(patch.deadline) : null;
  if (patch.responsibleId !== undefined)
    data.assigneeId = patch.responsibleId != null ? Number(patch.responsibleId) : null;
  if (patch.done !== undefined) {
    data.completed = !!patch.done;
    data.completedAt = patch.done ? new Date() : null;
  }
  const updated = await prisma.onboardingTask.update({
    where: { id: Number(taskId) },
    data,
    include: { assignee: { select: employeeProfileSelect } },
  });
  return taskRow(updated);
}

export async function completePortalTask({ tenantId, taskId, done = true } = {}) {
  return updatePortalTask({ tenantId, taskId, done });
}

export async function deletePortalTask({ tenantId, taskId } = {}) {
  await loadTaskScoped(tenantId, taskId);
  await prisma.onboardingTask.delete({ where: { id: Number(taskId) } });
  return { deleted: true, id: Number(taskId) };
}

// ── feedback ─────────────────────────────────────────────────────────────────
export async function getFeedbackQuestions({ tenantId, checklistId, employeeId } = {}) {
  let existing = null;
  if (checklistId != null || employeeId != null) {
    try {
      const checklist = await resolveChecklist({ tenantId, checklistId, employeeId });
      existing = await prisma.onboardingFeedback.findFirst({
        where: scopedWhere(tenantId, { checklistId: checklist.id }),
        select: { responses: true, comments: true, submittedAt: true, checklistId: true },
      });
    } catch {
      // No checklist yet — still return the blank questionnaire.
    }
  }
  return {
    questions: ONBOARDING_FEEDBACK_QUESTIONS,
    submitted: !!existing,
    responses: existing?.responses ?? null,
    comments: existing?.comments ?? null,
    submittedAt: existing?.submittedAt ?? null,
  };
}

export async function submitPortalFeedback({ tenantId, checklistId, employeeId, answers, comments } = {}) {
  const check = validateFeedbackAnswers(answers);
  if (!check.ok) throw new AppError(`Invalid feedback: ${check.error}`, 400);

  const checklist = await resolveChecklist({ tenantId, checklistId, employeeId });
  const empId = employeeId != null ? Number(employeeId) : checklist.employeeId;

  // Upsert-by-checklist (one feedback per onboarding). Two statements → tx so the
  // RLS GUC is set for both the read and the write.
  return tenantTransaction(
    prisma,
    async (tx) => {
      const prior = await tx.onboardingFeedback.findFirst({
        where: scopedWhere(tenantId, { checklistId: checklist.id }),
        select: { id: true },
      });
      const payload = {
        checklistId: checklist.id,
        employeeId: empId,
        responses: check.normalized,
        comments: comments ?? null,
        submittedAt: new Date(),
      };
      const saved = prior
        ? await tx.onboardingFeedback.update({ where: { id: prior.id }, data: payload })
        : await tx.onboardingFeedback.create({ data: scopedData(tenantId, payload) });
      return {
        id: saved.id,
        checklistId: saved.checklistId,
        submittedAt: saved.submittedAt,
        answers: saved.responses,
        comments: saved.comments,
      };
    },
    { tenantId }
  );
}

// ── send reminder (auto-selects the task's responsible person) ───────────────
export async function sendTaskReminder({ tenantId, taskId, subject, message, actor } = {}) {
  return tenantTransaction(
    prisma,
    async (tx) => {
      const task = await tx.onboardingTask.findFirst({
        where: scopedWhere(tenantId, { id: Number(taskId) }),
        include: {
          assignee: { select: employeeProfileSelect },
          checklist: { select: { id: true, employeeId: true } },
        },
      });
      if (!task) throw new AppError("Onboarding task not found", 404);

      // AUTO-select the recipient: the task's responsible employee.
      const recipient = task.assignee ? profileOf(task.assignee) : null;
      if (!recipient) {
        throw new AppError("This task has no responsible person assigned to remind", 400);
      }

      const categoryLabel = onboardingCategoryLabel(task.category);
      const finalSubject = subject || `Reminder: ${task.title}`;
      const finalMessage =
        message ||
        `This is a reminder to complete the onboarding task "${task.title}" (${categoryLabel})` +
          (task.dueDate ? ` due ${new Date(task.dueDate).toISOString().slice(0, 10)}` : "") +
          ".";

      // Emit the outbox event (in-app now, email disabled at source).
      const event = onboardingTaskReminderEvent(task, { actorId: actor?.employeeId ?? actor?.userId ?? actor?.email }, {
        employeeId: task.checklist?.employeeId,
        recipientId: recipient.id,
        subject: finalSubject,
        message: finalMessage,
        emailEnabled: EMAIL_ENABLED,
      });
      if (event && event.tenantId) {
        await enqueueHrDomainEvent(tx, event);
      } else {
        logger.warn({ taskId }, "onboarding reminder: no tenant on task row; event skipped");
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
    },
    { tenantId }
  );
}
