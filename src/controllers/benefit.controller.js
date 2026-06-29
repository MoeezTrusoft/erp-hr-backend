// src/controllers/benefit.controller.js — HR-BENEFITS-04
//
// HTTP boundary for the benefits surface. Threads the VERIFIED tenant
// (req.user.tenantId; T-P2.1) into every service call so reads/writes are
// tenant-scoped fail-closed. Service errors carry a {SVC}-nnnn `code` and a
// `statusCode` (404 for cross-tenant / not-found, 400 for validation) which is
// surfaced verbatim.
import * as svc from "../services/benefit.service.js";

const tenantOf = (req) => req.user?.tenantId;

const fail = (req, res, e) => {
  const status = e.statusCode || 400;
  res.status(status).json({
    success: false,
    message: e.message,
    errors: [{ code: e.code || "HR-4100", message: e.message }],
    requestId: req.requestId,
  });
};

// ── Benefit plans ─────────────────────────────────────────────────────────────
export const createPlan = async (req, res) => {
  try {
    const data = await svc.createPlan({ ...req.body, tenantId: tenantOf(req) });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const listPlans = async (req, res) => {
  try {
    const data = await svc.listPlans({
      type: req.query.type,
      active: req.query.active,
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const getPlan = async (req, res) => {
  try {
    const data = await svc.getPlan(req.params.id, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const updatePlan = async (req, res) => {
  try {
    const data = await svc.updatePlan(req.params.id, req.body, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const deletePlan = async (req, res) => {
  try {
    const data = await svc.deletePlan(req.params.id, tenantOf(req));
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

// ── Enrollment ────────────────────────────────────────────────────────────────
export const enrollEmployee = async (req, res) => {
  try {
    const data = await svc.enrollEmployee({
      employeeId: req.params.employeeId,
      benefitPlanId: req.body.benefitPlanId,
      electedAmount: req.body.electedAmount,
      tenantId: tenantOf(req),
    });
    res.status(201).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const unenrollEmployee = async (req, res) => {
  try {
    const data = await svc.unenrollEmployee({
      employeeId: req.params.employeeId,
      benefitPlanId: req.params.benefitPlanId,
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};

export const listEmployeeBenefits = async (req, res) => {
  try {
    const data = await svc.listEmployeeBenefits({
      employeeId: req.params.employeeId,
      status: req.query.status,
      tenantId: tenantOf(req),
    });
    res.status(200).json({ success: true, message: "Success", data });
  } catch (e) {
    fail(req, res, e);
  }
};
