import express from "express";
import {
  initiateReviews,
  submitReview,
  getCycleReviews,
  sendReviewReminder,
} from "../controllers/performanceReview.controller.js";

const router = express.Router();

router.post("/Create", initiateReviews);          // HR/Admin — idempotent bulk initiate
router.put("/submit/:id", submitReview);          // Self, Manager, Peer
router.get("/cycle/:cycleId", getCycleReviews);   // HR/Admin (D16: param is cycleId)
router.post("/reminder", sendReviewReminder);     // HR/Admin or System (svc:hr-jobs)

export default router;
