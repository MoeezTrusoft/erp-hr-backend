import {
  createRequisition,
  getAllRequisitions,
  approveRequisition,
  deleteRequisitions,
  getByIdRequisitions,
  updateRequisition,
} from "../services/requisition.service.js";
import {
  listRequisitionAttachments,
  addRequisitionAttachment,
  removeRequisitionAttachment,
} from "../services/requisitionAttachment.service.js";
import {
  publishRequisition,
  unpublishPosting,
  withdrawRequisition,
  listRequisitionPostings,
} from "../services/requisitionPublication.service.js";
import { respondPreconditionAware } from "../utils/httpError.js";
import { resolveEmployeeActor } from "../lib/employeeActor.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";

// Phase 2.2 — the attachment service throws with an explicit `status` (404 for a
// cross-tenant/unknown requisition, 403 for a caller who may not change
// documents, 422 for a category/visibility that cannot be stored). Flattening all
// of those into 400 would tell an interviewer "bad request" when the real answer
// is "not yours".
const respondAttachmentError = (res, error) => {
  const status = Number(error?.status) || 400;
  res.status(status).json({ success: false, message: error.message, code: error.code });
};

// Verified tenant from the service-JWT claim (mapped to req.user.tenantId by the
// gateway / MCP runner); `?? null` keeps it out of the scopedWhere fail-open
// (undefined) path so a missing tenant scopes to null rows, never all tenants.
const tenantOf = (req) => req.user?.tenantId ?? null;

// T-P2.1 / F-07 — the acting employee comes ONLY from the verified service-JWT
// claim (req.user), never from `employee-id` / `x-employee-id` / a body-supplied
// id. Requisition actions feed the Phase 3 state machine, whose approval record
// and audit trail must name the real actor: with a header-derived actor a caller
// could approve as someone else, and the MCP path (which sends no headers at all)
// recorded NO actor for approve/post/delete. `resolveEmployeeActor` keeps the
// admin case working — an RBAC-only account resolves by email, or null when the
// actor is pure audit metadata.
const actorOf = (req) => resolveEmployeeActor(req.user);

export const createRequisitionController = async (req, res) => {
  try {
    // `requestedById` is a BUSINESS field (the hiring manager) — who the role
    // reports to, not who is calling. It may legitimately differ from the caller.
    // The creator is the verified actor, never a header or a body employeeId.
    const requestedBy =
      req.body.requestedById ?? (await actorOf(req));
    const result = await createRequisition(req.body, requestedBy, tenantOf(req));
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// ── Phase 2.2 — requisition documents (decision record §1.4) ────────────────
// The caller's SCOPE, not a role name, decides what comes back: an ORG caller
// sees internal documents, a hiring manager or interviewer sees only the rows
// tagged HIRING_TEAM.
export const listRequisitionAttachmentsController = async (req, res) => {
  try {
    const result = await listRequisitionAttachments(req.params.id, tenantOf(req), resolveRecruitmentScope(req.user));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

export const addRequisitionAttachmentController = async (req, res) => {
  try {
    const result = await addRequisitionAttachment(
      req.params.id,
      tenantOf(req),
      resolveRecruitmentScope(req.user),
      { ...req.body, uploadedById: req.body?.uploadedById ?? (await actorOf(req)) },
    );
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

export const removeRequisitionAttachmentController = async (req, res) => {
  try {
    const result = await removeRequisitionAttachment(
      req.params.attachmentId,
      tenantOf(req),
      resolveRecruitmentScope(req.user),
    );
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

export const getRequisitionsController = async (req, res) => {
  try {
    // Phase 1.4 — the caller's role claim decides WHICH rows they may read; the
    // tenant decides which tenant. A hiring manager sees only their own.
    const result = await getAllRequisitions(tenantOf(req), resolveRecruitmentScope(req.user));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getByIdRequisitionsController = async (req, res) => {
  try {
    const result = await getByIdRequisitions(req.params.id, tenantOf(req), resolveRecruitmentScope(req.user));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const deletRequisitionsController = async (req, res) => {
  try {
    const deletedBy = await actorOf(req);
    const result = await deleteRequisitions(req.params.id, deletedBy, tenantOf(req));
    res.status(200).json({ success: true, message: "deleted SuccessFully" });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const approveRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const approvedBy = await actorOf(req);
    const { status, comments } = req.body;
    const result = await approveRequisition(id, status, comments, approvedBy, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const postRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const createdBy = await actorOf(req);
    const { externalUrl, postingChannels, channelRef } = req.body ?? {};
    // Phase 4 / §2.4 — publish to ONE OR MORE CHANNELS. `postingChannels` accepts
    // the compact form (["LINKEDIN", "CAREER_SITE"]) or the explicit form
    // ([{ channel, externalUrl, channelRef }]), and an absent list means the
    // built-in career site, which is what this endpoint used to do implicitly.
    const result = await publishRequisition({
      id,
      postingChannels,
      externalUrl,
      channelRef,
      actorId: createdBy,
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

// §2.4a — close ONE channel's posting. The requisition stays POSTED.
export const unpublishPostingController = async (req, res) => {
  try {
    const { reason, note } = req.body ?? {};
    const data = await unpublishPosting({
      postingId: req.params.postingId ?? null,
      requisitionId: req.params.id ?? null,
      channel: req.params.channel ?? null,
      reason,
      note,
      actorId: await actorOf(req),
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

// §2.4a / FR-01.07 — withdraw the requisition. Requires a coded reason and closes
// ALL active postings in the same transaction.
export const withdrawRequisitionController = async (req, res) => {
  try {
    const { reason, note } = req.body ?? {};
    const data = await withdrawRequisition({
      id: req.params.id,
      reason,
      note,
      actorId: await actorOf(req),
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

export const listRequisitionPostingsController = async (req, res) => {
  try {
    const includeClosed = String(req.query.includeClosed ?? "true") !== "false";
    const data = await listRequisitionPostings(req.params.id, tenantOf(req), { includeClosed });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respondAttachmentError(res, error);
  }
};

export const updateRequisitionController = async (req, res) => {
  try {
    const { id } = req.params;
    const updatedBy = await actorOf(req);
    const result = await updateRequisition(id, req.body, updatedBy, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    // API-2 — surface a stale-write as 412 (HR-4120) with currentVersion; every
    // other error keeps the existing 400 behavior.
    if (respondPreconditionAware(res, error)) return;
    res.status(400).json({ success: false, message: error.message });
  }
};
