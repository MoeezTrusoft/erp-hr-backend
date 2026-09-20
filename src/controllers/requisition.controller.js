import {
  createRequisition,
  getAllRequisitions,
  approveRequisition,
  postRequisition,
  deleteRequisitions,
  getByIdRequisitions,
  updateRequisition,
} from "../services/requisition.service.js";
import { respondPreconditionAware } from "../utils/httpError.js";
import { resolveEmployeeActor } from "../lib/employeeActor.js";
import { resolveRecruitmentScope } from "../lib/recruitmentAccess.js";

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
    const { externalUrl } = req.body;
    const result = await postRequisition(id, externalUrl, createdBy, tenantOf(req));
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
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
