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
router.get("/:employeeId", getReviewsByEmployee);
router.put("/:id", updateReview);

router.post("/", addFeedback);
router.put("/:id", updateFeedback);
router.delete("/:id", deleteFeedback);

router.get("/metrics", listMetrics);
router.post("/metrics", createMetric);
router.delete("/metrics/:id", deactivateMetric);

// Review items per review
router.get("/reviews/:reviewId/items", getReviewItems);
router.post("/reviews/:reviewId/items", upsertReviewItems);

export default router;
