import express from "express";
import { addFeedback, createPerformanceReview, deleteFeedback, getAllReviews, getReviewsByEmployee, updateFeedback, updateReview } from "../controllers/performance.controller.js";
import {
    createMetric,
    listMetrics,
    deactivateMetric,
    upsertReviewItems,
    getReviewItems,
} from "../controllers/performanceMetricController.js";
const router = express.Router();

router.post("/", createPerformanceReview);
router.get("/", getAllReviews);

router.put("/:id", updateReview);

router.post("/feedback", addFeedback);
router.put("/feedback/:id", updateFeedback);
router.delete("/feedback/:id", deleteFeedback);

router.get("/metrics", listMetrics);
router.post("/metrics", createMetric);
router.delete("/metrics/:id", deactivateMetric);

// Review items per review
router.get("/reviews/:reviewId/items", getReviewItems);
router.post("/reviews/:reviewId/items", upsertReviewItems);

router.get("/employees/:employeeId", getReviewsByEmployee);
export default router;
