import * as performanceService from "../services/performance.service.js";
import { respondServerError } from '../utils/httpError.js';

export const createPerformanceReview = async (req, res) => {
  try {
     const createdBy = req.headers['employee-id'];
    const review = await performanceService.createPerformanceReview(req.body,createdBy, req.user?.tenantId ?? null);
    res.status(201).json({ success: true, review });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getAllReviews = async (req, res) => {
  try {
    const { items, ...pagination } = await performanceService.getAllReviews(req.user?.tenantId ?? null, req.query ?? {});
    res.json({ success: true, reviews: items, ...pagination });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

// Per-employee nine-box aggregate backing the Performance Analytics grid.
// Tenant-scoped (fail-closed) from the verified service-JWT claim.
export const listEmployeeNineBox = async (req, res) => {
  try {
    const tenantId = req.user?.tenantId ?? null;
    const data = await performanceService.getEmployeeNineBox(tenantId);
    res.status(200).json({ success: true, data });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const getReviewsByEmployee = async (req, res) => {
  try {
    const reviews = await performanceService.getReviewsByEmployee(req.params.employeeId, req.user?.tenantId ?? null);
    res.json({ success: true, reviews });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const updateReview = async (req, res) => {
  try {
     const updatedBy = req.headers['employee-id'];
    const review = await performanceService.updateReview(req.params.id, req.body,updatedBy, req.user?.tenantId ?? null);
    res.json({ success: true, review });
  } catch (error) {
    respondServerError(req, res, error);
  }
};



export const addFeedback = async (req, res) => {
  try {
     const createdBy = req.headers['employee-id'];
    const feedback = await performanceService.addFeedback(req.body,createdBy, req.user?.tenantId ?? null);
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    respondServerError(req, res, error);
  }
};

export const updateFeedback = async (req, res) => {
  try {
     const updatedBy = req.headers['employee-id'];
    const feedback = await performanceService.updateFeedback(req.params.id,req.body,updatedBy, req.user?.tenantId ?? null);
    res.status(201).json({ success: true, feedback });
  } catch (error) {
    respondServerError(req, res, error);
  }
};


export const deleteFeedback = async (req, res) => {
  try {
             const deletedBy = req.headers['employee-id'];

    const result = await performanceService.deleteFeedback(req.params.id,deletedBy, req.user?.tenantId ?? null);
    res.json({ success: true, message: result.message });
  } catch (error) {
    respondServerError(req, res, error);
  }
};
