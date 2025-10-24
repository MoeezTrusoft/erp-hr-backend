import express from "express";
import { createCourse, deleteCourse, getAllCourses, getCourseAnalytics, getCourseById, getGlobalAnalyticsOverview, getUpcomingCourses, updateCourse } from "../controllers/trainingCourse.controller.js";

const router = express.Router();

router.post("/", createCourse);
router.get("/", getAllCourses);
router.get("/upcoming",getUpcomingCourses); // NEW
router.get("/analytics/overview", getGlobalAnalyticsOverview); // NEW global analytics
router.get("/:id", getCourseById);
router.get("/analytics/:id", getCourseAnalytics); // NEW per-course analytics
router.put("/:id", updateCourse);
router.delete("/:id", deleteCourse);

export default router;
