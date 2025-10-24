import express from "express";
import { addFeedback, createPerformanceReview, deleteFeedback, getAllReviews, getReviewsByEmployee, updateFeedback, updateReview } from "../controllers/performance.controller.js";

const router = express.Router();

router.post("/create", createPerformanceReview);
router.get("/all", getAllReviews);
router.get("/employee/:employeeId", getReviewsByEmployee);
router.put("/:id", updateReview);

router.post("/feedback", addFeedback);
router.put("/update-feedback/:id", updateFeedback);
router.delete("/delete-feedback/:id", deleteFeedback);

export default router;
