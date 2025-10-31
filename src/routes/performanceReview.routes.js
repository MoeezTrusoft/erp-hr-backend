import express from "express";
import {
  initiateReviews,
  submitReview,
  getCycleReviews,
  sendReviewReminder,
} from "../controllers/performanceReview.controller.js";

const router = express.Router();

router.post("/Create", initiateReviews);         // HR/Admin
router.put("/submit/:id", submitReview);          // Self, Manager, Peer
router.get("/cycle/:CycleId", getCycleReviews);    // HR/Admin
router.post("/reminder", sendReviewReminder);      // HR/Admin or System

export default router;
