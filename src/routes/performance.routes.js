import express from "express";
import { addFeedback, createPerformanceReview, deleteFeedback, getAllReviews, getReviewsByEmployee, updateFeedback, updateReview } from "../controllers/performance.controller.js";

const router = express.Router();

router.post("/", createPerformanceReview);
router.get("/", getAllReviews);
router.get("/employeeId", getReviewsByEmployee);
router.put("/:id", updateReview);

router.post("/", addFeedback);
router.put("/:id", updateFeedback);
router.delete("/:id", deleteFeedback);

export default router;
