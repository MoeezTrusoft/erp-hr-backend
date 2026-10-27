import * as performanceReviewService from "../services/performanceReview.service.js";
import { actorOf, respondPerformanceError, tenantOf } from "./performance.respond.js";

export const initiateReviews = async (req, res) => {
  try {
    const { cycleId, employeeIds, reviewType } = req.body || {};
    const result = await performanceReviewService.initiateReviewsService(
      cycleId,
      employeeIds,
      actorOf(req),
      tenantOf(req),
      reviewType
    );
    res.status(201).json({ success: true, created: result.count, skipped: result.skipped, cycleId: result.cycleId });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const submitReview = async (req, res) => {
  try {
    const result = await performanceReviewService.submitReviewService(req.params.id, req.body, actorOf(req), tenantOf(req));
    res.status(200).json({ success: true, review: result });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const getCycleReviews = async (req, res) => {
  try {
    // D16: the route param is `cycleId` (the router used to declare `CycleId`).
    const result = await performanceReviewService.getCycleReviewsService(req.params.cycleId, tenantOf(req));
    res.status(200).json({ success: true, reviews: result });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};

export const sendReviewReminder = async (req, res) => {
  try {
    const { reviewId, sentToId, type } = req.body || {};
    const reminder = await performanceReviewService.sendReviewReminderService(
      reviewId,
      sentToId,
      type,
      actorOf(req),
      tenantOf(req)
    );
    res.status(200).json({ success: true, reminder });
  } catch (error) {
    respondPerformanceError(req, res, error);
  }
};
