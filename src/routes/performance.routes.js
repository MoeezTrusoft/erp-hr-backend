import express from "express";
import {
  addFeedback,
  createPerformanceReview,
  deleteFeedback,
  getAllReviews,
  getReviewsByEmployee,
  listEmployeeNineBox,
  updateFeedback,
  updateReview,
} from "../controllers/performance.controller.js";
import {
  createMetric,
  listMetrics,
  deactivateMetric,
  upsertReviewItems,
  getReviewItems,
} from "../controllers/performanceMetricController.js";
const router = express.Router();

// PERF-P0 (E-01 / D15): literal paths are declared BEFORE the `/:employeeId`
// and `/:id` params so `/metrics`, `/nine-box`, `/feedback` and `/reviews/...`
// are no longer captured as an employee id. Feedback has its own prefix — the
// former duplicate `POST /` / `PUT /:id` registrations were unreachable.

// Metrics catalog
router.get("/metrics", listMetrics);
router.post("/metrics", createMetric);
router.delete("/metrics/:id", deactivateMetric);

// Per-employee nine-box aggregate (also served as the hr://performance/metrics resource)
router.get("/nine-box", listEmployeeNineBox);

// Review items per review
router.get("/reviews/:reviewId/items", getReviewItems);
router.post("/reviews/:reviewId/items", upsertReviewItems);

// Feedback on a review
router.post("/feedback", addFeedback);
router.put("/feedback/:id", updateFeedback);
router.delete("/feedback/:id", deleteFeedback);

// Reviews
router.post("/", createPerformanceReview);
router.get("/", getAllReviews);
router.get("/:employeeId", getReviewsByEmployee);
router.put("/:id", updateReview);

export default router;
