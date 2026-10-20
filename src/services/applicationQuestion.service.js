// src/services/applicationQuestion.service.js
//
// Phase 5 / decision record §3.5 — recruiter CRUD for per-requisition
// application questions.
//
// The one rule that shapes this file: a question THAT HAS ANSWERS is
// immutable. Editing it in place would silently change what past candidates
// were asked (and how their stored scores were computed). Instead:
//
//   * a question with no answers  -> edited in place (it never shipped)
//   * a question with answers     -> deactivated and a new version row is
//     created; past applications keep pointing at the old version
//
// Ordering, question-set integrity and scoring bounds are all delegated to the
// pure module in src/lib/applicationQuestions.js — the REST path and the MCP
// path both come through here, so they cannot diverge.
//
// Recruitment Phase 2 — the knockout flag and rule are validated by the same
// module; a bad rule is refused with HR-RECRUITMENT-KNOCKOUT-RULE-INVALID so the
// caller can tell it apart from an ordinary definition error.

import { Prisma } from "@prisma/client";
import prisma from "../config/prisma.js";
import { validateQuestionDefinition } from "../lib/applicationQuestions.js";

export class ApplicationQuestionError extends Error {
  constructor(message, status = 400, details = undefined, code = undefined) {
    super(message);
    this.name = "ApplicationQuestionError";
    this.status = status;
    this.details = details;
    if (code) this.code = code;
  }
}

/** The 400 for a definition that failed validation, coded by what failed. */
function invalidDefinition({ errors, knockoutErrors = [] }) {
  if (knockoutErrors.length) {
    return new ApplicationQuestionError("Invalid knockout rule", 400, { errors }, "HR-RECRUITMENT-KNOCKOUT-RULE-INVALID");
  }
  return new ApplicationQuestionError("Invalid question definition", 400, { errors }, "HR-RECRUITMENT-QUESTION-INVALID");
}

async function assertRequisitionManageable(requisitionId, tenantId) {
  const requisition = await prisma.jobRequisition.findFirst({
    where: { id: requisitionId, tenantId },
    select: { id: true, status: true },
  });
  if (!requisition) {
    throw new ApplicationQuestionError("Requisition not found", 404);
  }
  return requisition;
}

/** List the active question set for a requisition (admin view). */
export async function listQuestions(requisitionId, tenantId) {
  return prisma.applicationQuestion.findMany({
    where: { requisitionId, tenantId, isActive: true },
    orderBy: [{ orderIndex: "asc" }, { id: "asc" }],
    select: {
      id: true,
      version: true,
      orderIndex: true,
      type: true,
      prompt: true,
      required: true,
      options: true,
      weights: true,
      maxScore: true,
      knockout: true,
      knockoutRule: true,
      isActive: true,
    },
  });
}

/**
 * Create one question on a requisition. The definition is validated by the
 * pure module; `actorId` is accepted for future audit columns.
 */
export async function createQuestion(requisitionId, tenantId, definition, _actorId = undefined) {
  await assertRequisitionManageable(requisitionId, tenantId);

  const validation = validateQuestionDefinition(definition);
  const { ok, normalized } = validation;
  if (!ok) throw invalidDefinition(validation);

  // Prompt uniqueness within the requisition's active set.
  const dupe = await prisma.applicationQuestion.findFirst({
    where: { requisitionId, tenantId, isActive: true, prompt: normalized.prompt },
    select: { id: true },
  });
  if (dupe) {
    throw new ApplicationQuestionError(
      `A question with this prompt already exists on the requisition`,
      409,
      { errors: [`duplicate question prompt: "${normalized.prompt}"`] },
    );
  }

  const maxOrder = await prisma.applicationQuestion.aggregate({
    where: { requisitionId, tenantId },
    _max: { orderIndex: true },
  });
  const orderIndex = definition.orderIndex ?? (maxOrder._max.orderIndex ?? -1) + 1;

  return prisma.applicationQuestion.create({
    data: {
      requisitionId,
      tenantId,
      version: 1,
      orderIndex,
      type: normalized.type,
      prompt: normalized.prompt,
      required: normalized.required,
      options: normalized.options ?? undefined,
      weights: normalized.weights ?? undefined,
      maxScore: normalized.maxScore,
      knockout: normalized.knockout,
      knockoutRule: normalized.knockoutRule ?? undefined,
      isActive: normalized.isActive,
    },
  });
}

/**
 * Update a question. If it already has answers, refuse in-place mutation and
 * tell the caller to create a new version instead — the caller-facing contract
 * from §3.5 ("questions are versioned").
 */
export async function updateQuestion(requisitionId, tenantId, questionId, definition, _actorId = undefined) {
  await assertRequisitionManageable(requisitionId, tenantId);

  const existing = await prisma.applicationQuestion.findFirst({
    where: { id: questionId, requisitionId, tenantId, isActive: true },
    include: { _count: { select: { answers: true } } },
  });
  if (!existing) throw new ApplicationQuestionError("Question not found", 404);

  if (existing._count.answers > 0) {
    throw new ApplicationQuestionError(
      "This question already has answers and cannot be edited. Deactivate it and create a new version.",
      409,
      { questionId, answerCount: existing._count.answers },
    );
  }

  // Turning knockout off drops the stored rule with it; otherwise an omitted
  // rule keeps the stored one.
  const knockout = definition.knockout ?? existing.knockout ?? false;
  const knockoutRule = definition.knockout === false
    ? definition.knockoutRule ?? null
    : definition.knockoutRule ?? existing.knockoutRule ?? null;
  const validation = validateQuestionDefinition({
    // An update carries only what changes; everything unspecified falls back to
    // the stored definition so a prompt-only edit doesn't have to resend the
    // options and weights (and can't accidentally blank them).
    type: definition.type ?? existing.type,
    prompt: definition.prompt ?? existing.prompt,
    required: definition.required ?? existing.required,
    orderIndex: definition.orderIndex ?? existing.orderIndex,
    options: definition.options ?? existing.options ?? undefined,
    weights: definition.weights ?? existing.weights ?? undefined,
    knockout,
    knockoutRule,
    isActive: definition.isActive ?? existing.isActive,
  });
  const { ok, normalized } = validation;
  if (!ok) throw invalidDefinition(validation);

  if (normalized.prompt !== existing.prompt) {
    const dupe = await prisma.applicationQuestion.findFirst({
      where: {
        requisitionId,
        tenantId,
        isActive: true,
        prompt: normalized.prompt,
        id: { not: questionId },
      },
      select: { id: true },
    });
    if (dupe) {
      throw new ApplicationQuestionError("A question with this prompt already exists on the requisition", 409);
    }
  }

  return prisma.applicationQuestion.update({
    where: { id: questionId },
    data: {
      orderIndex: normalized.orderIndex,
      type: normalized.type,
      prompt: normalized.prompt,
      required: normalized.required,
      options: normalized.options ?? undefined,
      weights: normalized.weights ?? undefined,
      maxScore: normalized.maxScore,
      knockout: normalized.knockout,
      // A Json column is cleared with Prisma.DbNull (plain null is refused), so
      // switching knockout off really removes the stored rule.
      knockoutRule: normalized.knockoutRule ?? Prisma.DbNull,
      isActive: normalized.isActive,
    },
  });
}

/**
 * Deactivate a question. Soft by design: history keeps pointing at it, and the
 * public portal simply stops asking it. If no answers exist yet it is deleted
 * outright — a typo'd question shouldn't linger forever.
 */
export async function deactivateQuestion(requisitionId, tenantId, questionId) {
  await assertRequisitionManageable(requisitionId, tenantId);

  const existing = await prisma.applicationQuestion.findFirst({
    where: { id: questionId, requisitionId, tenantId, isActive: true },
    include: { _count: { select: { answers: true } } },
  });
  if (!existing) throw new ApplicationQuestionError("Question not found", 404);

  if (existing._count.answers > 0) {
    await prisma.applicationQuestion.update({
      where: { id: questionId },
      data: { isActive: false },
    });
    return { deactivated: true, deleted: false };
  }
  await prisma.applicationQuestion.delete({ where: { id: questionId } });
  return { deactivated: false, deleted: true };
}

/** Reorder the active set in one write. Accepts the full desired order. */
export async function reorderQuestions(requisitionId, tenantId, orderedIds) {
  await assertRequisitionManageable(requisitionId, tenantId);

  const active = await prisma.applicationQuestion.findMany({
    where: { requisitionId, tenantId, isActive: true },
    select: { id: true },
  });
  const activeIds = new Set(active.map((q) => q.id));
  const provided = Array.isArray(orderedIds) ? orderedIds.map(Number) : [];
  if (provided.length !== activeIds.size || provided.some((id) => !activeIds.has(id))) {
    throw new ApplicationQuestionError(
      "orderedIds must contain exactly the requisition's active question ids, in the desired order",
      400,
    );
  }

  const tx = [];
  provided.forEach((id, index) => {
    tx.push(prisma.applicationQuestion.update({ where: { id }, data: { orderIndex: index } }));
  });
  await prisma.$transaction(tx);
  return listQuestions(requisitionId, tenantId);
}

export default {
  listQuestions,
  createQuestion,
  updateQuestion,
  deactivateQuestion,
  reorderQuestions,
};
