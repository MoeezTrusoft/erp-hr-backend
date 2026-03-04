import express from "express";
import * as ctrl from "../controllers/offboarding.controller.js";
import dynamicUpload from "../middlewares/upload.middleware.js";

const router = express.Router();

router.post("/", ctrl.createOffboarding);
router.get("/employee/:employeeId", ctrl.getOffboardingByEmployee);
router.get("/:id", ctrl.getOffboarding);
router.put("/:id", ctrl.updateOffboarding);
router.post("/:id/tasks", ctrl.addOffboardingTask);
router.put("/tasks/:taskId", ctrl.updateOffboardingTask);
router.post("/:id/exit-interview", dynamicUpload, ctrl.uploadExitInterview);

export default router;
