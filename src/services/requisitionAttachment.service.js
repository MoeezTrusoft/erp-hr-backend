// src/services/requisitionAttachment.service.js
//
// Phase 2.2 / decision record §1.4 — typed, ACL'd requisition attachments.
//
// The BYTES live in DAM; this service owns the POINTER and, more importantly, the
// visibility rule. Attaching a document to a requisition is not a single
// permission: a business justification or budget-approval document must never
// reach an interviewer's or candidate's view just because the job description
// rides on the same requisition.
//
// Two enforced rules, in both directions:
//   * READ  — a non-ORG caller only ever sees `visibility = 'HIRING_TEAM'` rows.
//   * WRITE — a category that is not hiring-team material can never be TAGGED
//             `HIRING_TEAM`. Without this the read filter is theatre: the caller
//             who uploads the budget document could simply mislabel it.
//
// There is no candidate-facing visibility value at all, so no future reader can
// accidentally serve an internal document to a candidate portal by picking it up
// from here (candidate-facing publication assets are managed separately).
import prisma from "../lib/prisma.js";
import { scopedWhere, scopedData } from "../lib/tenancy.js";
import {
  attachmentAudience,
  canManageRequisitionAttachments,
  requisitionAttachmentScopeWhere,
} from "../lib/recruitmentAccess.js";
import { ATTACHMENT_CATEGORIES, ATTACHMENT_VISIBILITIES, HIRING_TEAM_VISIBLE_CATEGORIES } from "../lib/requisitionFields.js";

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const normalizeCategory = (value) => {
  const category = String(value ?? "").trim().toUpperCase();
  if (!ATTACHMENT_CATEGORIES.includes(category)) {
    throw fail(
      `category must be one of: ${ATTACHMENT_CATEGORIES.join(", ")}`,
      422,
      "HR-RECRUITMENT-ATTACHMENT-CATEGORY-INVALID",
    );
  }
  return category;
};

const normalizeVisibility = (value, category) => {
  const visibility = value ? String(value).trim().toUpperCase() : "INTERNAL";
  if (!ATTACHMENT_VISIBILITIES.includes(visibility)) {
    throw fail(
      `visibility must be one of: ${ATTACHMENT_VISIBILITIES.join(", ")}`,
      422,
      "HR-RECRUITMENT-ATTACHMENT-VISIBILITY-INVALID",
    );
  }
  // The floor, not a ceiling: filing a budget document as hiring-team material is
  // exactly the leak the read filter exists to prevent, so it is refused rather
  // than silently downgraded (a silent downgrade hides a UI bug).
  if (visibility === "HIRING_TEAM" && !HIRING_TEAM_VISIBLE_CATEGORIES.includes(category)) {
    throw fail(
      `A ${category} document cannot be shared with the hiring team`,
      422,
      "HR-RECRUITMENT-ATTACHMENT-VISIBILITY-REFUSED",
    );
  }
  return visibility;
};

// Tenant-scoped existence check. A cross-tenant (or unknown) requisition is
// NOT FOUND, never FORBIDDEN — a 403 on a guessed id confirms the row exists.
const requireRequisition = async (requisitionId, tenantId) => {
  const id = toInt(requisitionId);
  if (!id) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
  const requisition = await prisma.jobRequisition.findFirst({
    where: scopedWhere(tenantId, { id }),
    select: { id: true },
  });
  if (!requisition) throw fail("Requisition not found", 404, "HR-RECRUITMENT-REQUISITION-NOT-FOUND");
  return requisition.id;
};

/**
 * Attachments on one requisition, filtered to what the caller's scope may read.
 * Returns [] rather than throwing so a detail view renders without a special case.
 */
export const listRequisitionAttachments = async (requisitionId, tenantId, scope) => {
  const id = await requireRequisition(requisitionId, tenantId);
  return prisma.requisitionAttachment.findMany({
    where: scopedWhere(tenantId, { requisitionId: id, ...requisitionAttachmentScopeWhere(scope) }),
    orderBy: { id: "asc" },
  });
};

/**
 * Attach a document. `scope` decides whether the caller may write at all, and
 * `visibility` is validated against the CATEGORY — never trusted from the body.
 */
export const addRequisitionAttachment = async (
  requisitionId,
  tenantId,
  scope,
  { category, visibility, mediaId, fileName, label, uploadedById } = {},
) => {
  if (!canManageRequisitionAttachments(scope)) {
    throw fail("Not permitted to change requisition documents", 403, "HR-RECRUITMENT-ATTACHMENT-FORBIDDEN");
  }
  const id = await requireRequisition(requisitionId, tenantId);
  const normalizedCategory = normalizeCategory(category);
  const normalizedVisibility = normalizeVisibility(visibility, normalizedCategory);

  return prisma.requisitionAttachment.create({
    data: scopedData(tenantId, {
      requisitionId: id,
      category: normalizedCategory,
      visibility: normalizedVisibility,
      mediaId: toInt(mediaId),
      fileName: fileName ? String(fileName) : null,
      label: label ? String(label) : null,
      uploadedById: toInt(uploadedById),
    }),
  });
};

export const removeRequisitionAttachment = async (attachmentId, tenantId, scope) => {
  if (!canManageRequisitionAttachments(scope)) {
    throw fail("Not permitted to change requisition documents", 403, "HR-RECRUITMENT-ATTACHMENT-FORBIDDEN");
  }
  const id = toInt(attachmentId);
  if (!id) throw fail("Attachment not found", 404, "HR-RECRUITMENT-ATTACHMENT-NOT-FOUND");

  // The delete is conditioned on the tenant AND on the row being readable by this
  // caller's audience, so a hiring-team caller cannot delete an internal document
  // it was not allowed to know about. deleteMany (not delete) so a non-matching id
  // is a clean 0 rather than a Prisma "not found" throw.
  const audience = attachmentAudience(scope);
  const where = scopedWhere(tenantId, {
    id,
    ...(audience === "INTERNAL" ? {} : { visibility: "HIRING_TEAM" }),
  });
  const before = await prisma.requisitionAttachment.findFirst({ where, select: { id: true } });
  if (!before) throw fail("Attachment not found", 404, "HR-RECRUITMENT-ATTACHMENT-NOT-FOUND");

  await prisma.requisitionAttachment.deleteMany({ where });
  return { id, deleted: true };
};
