import *as performanceReviewService from "../services/performanceReview.service.js";

export const initiateReviews = async (req, res) => {
  try {
    const reviewedBy = req.user?.employeeId;

    const { cycleId, employeeIds } = req.body;
    const result = await performanceReviewService.initiateReviewsService(cycleId, employeeIds, reviewedBy, req.user?.tenantId);
    res.status(201).json({ success: true, created: result.count });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const submitReview = async (req, res) => {
  try {
    const submittedBy = req.user?.employeeId;

    const result = await performanceReviewService.submitReviewService(req.params.id, req.body, submittedBy, req.user?.tenantId);
    res.status(200).json({ success: true, review: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getCycleReviews = async (req, res) => {
  try {
    const result = await performanceReviewService.getCycleReviewsService(req.params.cycleId, req.user?.tenantId);
    res.status(200).json({ success: true, reviews: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const sendReviewReminder = async (req, res) => {
  try {
    const sentBy = req.user?.employeeId;
    const { reviewId, sentToId, type } = req.body;
    const reminder = await performanceReviewService.sendReviewReminderService(reviewId, sentToId, sentBy, req.user?.tenantId);
    res.status(200).json({ success: true, reminder });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};
