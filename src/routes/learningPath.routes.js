import express from "express";
import * as ctrl from "../controllers/learningPath.controller.js";

const router = express.Router();

router.post("/", ctrl.createPath);
router.get("/", ctrl.listPaths);
router.get("/:id", ctrl.getPath);
router.put("/:id", ctrl.updatePath);
router.post("/:id/courses", ctrl.addCourseToPath);
router.post("/:id/enroll", ctrl.enrollEmployee);

export default router;
