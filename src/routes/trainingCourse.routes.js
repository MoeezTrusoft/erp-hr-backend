import express from "express";
import {
  createCourse,
  deleteCourse,
  getAllCourses,
  getCourseAnalytics,
  getCourseById,
  getGlobalAnalyticsOverview,
  getUpcomingCourses,
  updateCourse,
  uploadCourseMaterial,
} from "../controllers/trainingCourse.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", createCourse);
router.get("/", getAllCourses);
router.get("/upcoming", getUpcomingCourses);
router.get("/analytics/overview", getGlobalAnalyticsOverview);
router.get("/analytics/:id", getCourseAnalytics);
router.get("/:id", getCourseById);
router.put("/:id", updateCourse);
router.delete("/:id", deleteCourse);
router.post("/:id/content", dynamicUpload, uploadCourseMaterial);

export default router;
