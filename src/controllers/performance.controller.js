import * as performanceService from "../services/performance.service.js";
import { respondServerError } from "../utils/httpError.js";
import { actorOf, respondPerformanceError, tenantOf } from "./performance.respond.js";

// PERF-P0: the verified tenant (req.user.tenantId, T-P2.1) is threaded into
// every service call (it used to be omitted here and the structural extension
// was the only scope); typed errors render with their real status.

export const createPerformanceReview = async (req, res) => {
  try {
    const review = await performanceService.createPerformanceReview(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, review });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const getAllReviews = async (req, res) => {
  try {
    const { items, total, page, limit } = await performanceService.getAllReviews(tenantOf(req), req.query || {});
    res.json({ success: true, reviews: items, total, page, limit });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

// Per-employee nine-box aggregate backing the Performance Analytics grid.
// Tenant-scoped (fail-closed) from the verified service-JWT claim.
export const listEmployeeNineBox = async (req, res) => {
  try {
    const tenantId = req.user?.tenantId ?? null;
    const data = await performanceService.getEmployeeNineBox(tenantId, { cycleId: req.query?.cycleId });
    res.status(200).json({ success: true, data });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getReviewsByEmployee = async (req, res) => {
  try {
    const reviews = await performanceService.getReviewsByEmployee(req.params.employeeId, tenantOf(req));
    res.json({ success: true, reviews });
  } catch (error) {
    respondPerformanceError(req, res, error, 404);
  }
};

export const updateReview = async (req, res) => {
  try {
    const review = await performanceService.updateReview(req.params.id, req.body, actorOf(req), tenantOf(req));
    res.json({ success: true, review });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const addFeedback = async (req, res) => {
  try {
    const feedback = await performanceService.addFeedback(req.body, actorOf(req), tenantOf(req));
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const updateFeedback = async (req, res) => {
  try {
    const feedback = await performanceService.updateFeedback(req.params.id, req.body, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, feedback });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const deleteFeedback = async (req, res) => {
  try {
    const result = await performanceService.deleteFeedback(req.params.id, actorOf(req), tenantOf(req));
    res.json({ success: true, message: result.message });
  } catch (error) {
    respondPerformanceError(req, res, error, 404);
  }
};
