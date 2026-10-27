// src/controllers/requisitionApprovalChain.controller.js
//
// Phase 4 / decision record §2.5 — the approval-matrix surface.
//
// Authorization is the F-02 route policy, not anything here. The routes live
// under `/api/recruitment/approval-matrix`, which routeAuthorization maps to the
// dedicated `hr.recruitment.approval.matrix` resource ahead of the general
// `/api/recruitment` prefix — configuring who must sign off on a requisition is
// not an ordinary recruitment write, so a recruiter's grant must not carry it.
import {
  listApprovalRules,
  seedDefaultChain,
  setApprovalRules,
} from "../services/requisition-approval-chain.service.js";
import { DEFAULT_CHAIN } from "../lib/requisition-approval-chain.util.js";

const tenantOf = (req) => req.user?.tenantId ?? null;

const respond = (res, error) => {
  const status = Number(error?.status) || 400;
  res.status(status).json({ success: false, message: error.message, code: error.code });
};

export const listApprovalMatrixController = async (req, res) => {
  try {
    const includeInactive = ["1", "true"].includes(String(req.query?.includeInactive ?? "").toLowerCase());
    const data = await listApprovalRules(tenantOf(req), { includeInactive });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};

// The recommended chain, returned as data so a UI can show it before applying it.
export const getDefaultApprovalMatrixController = async (_req, res) => {
  res.status(200).json({ success: true, data: DEFAULT_CHAIN });
};

export const setApprovalMatrixController = async (req, res) => {
  try {
    const data = await setApprovalRules(tenantOf(req), req.body?.steps ?? req.body?.rules ?? []);
    res.status(200).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};

export const seedDefaultApprovalMatrixController = async (req, res) => {
  try {
    const data = await seedDefaultChain(tenantOf(req));
    res.status(201).json({ success: true, data });
  } catch (error) {
    respond(res, error);
  }
};
